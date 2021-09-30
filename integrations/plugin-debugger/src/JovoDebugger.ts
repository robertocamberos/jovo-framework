import {
  AnyObject,
  App,
  DeepPartial,
  Extensible,
  ExtensibleInitConfig,
  HandleRequest,
  InvalidParentError,
  Jovo,
  JovoError,
  JovoRequest,
  Platform,
  Plugin,
  PluginConfig,
  UnknownObject,
} from '@jovotech/framework';
import { NlpjsNlu, NlpjsNluInitConfig } from '@jovotech/nlu-nlpjs';
import { CorePlatform, CorePlatformConfig } from '@jovotech/platform-core';
import { LangEn } from '@nlpjs/lang-en';
import isEqual from 'fast-deep-equal/es6';
import { promises } from 'fs';
import { join } from 'path';
import { cwd } from 'process';
import { connect, Socket } from 'socket.io-client';
import { Writable } from 'stream';
import { v4 as uuidV4 } from 'uuid';
import { MockServer } from './MockServer';

export enum JovoDebuggerEvent {
  DebuggingAvailable = 'debugging.available',
  DebuggingUnavailable = 'debugging.unavailable',

  DebuggerRequest = 'debugger.request',
  DebuggerLanguageModelRequest = 'debugger.language-model-request',

  AppLanguageModelResponse = 'app.language-model-response',
  AppDebuggerConfigResponse = 'app.debugger-config-response',
  AppConsoleLog = 'app.console-log',
  AppRequest = 'app.request',
  AppResponse = 'app.response',

  AppJovoUpdate = 'app.jovo-update',
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface JovoDebuggerPayload<DATA extends any = any> {
  requestId: number | string;
  data: DATA;
}

export interface JovoUpdateData<KEY extends keyof Jovo | string = keyof Jovo | string> {
  key: KEY;
  /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
  value: KEY extends keyof Jovo ? Jovo[KEY] : any;
  path: KEY extends keyof Jovo ? KEY : string;
}

export interface JovoDebuggerConfig extends PluginConfig {
  corePlatform: ExtensibleInitConfig<CorePlatformConfig>;
  nlpjsNlu: NlpjsNluInitConfig;
  webhookUrl: string;
  languageModelEnabled: boolean;
  languageModelPath: string;
  debuggerJsonPath: string;
  ignoredProperties: Array<keyof Jovo | string>;
}

export type JovoDebuggerInitConfig = DeepPartial<JovoDebuggerConfig> &
  Partial<Pick<JovoDebuggerConfig, 'nlpjsNlu'>>;

export class JovoDebugger extends Plugin<JovoDebuggerConfig> {
  socket?: typeof Socket;
  hasOverriddenWrite = false;

  constructor(config?: JovoDebuggerInitConfig) {
    super(config);
  }

  getDefaultConfig(): JovoDebuggerConfig {
    return {
      skipTests: true,
      corePlatform: {},
      nlpjsNlu: {
        languageMap: {
          en: LangEn,
        },
      },
      webhookUrl: 'https://webhookv4.jovo.cloud',
      enabled:
        (process.argv.includes('--jovo-webhook') || process.argv.includes('--webhook')) &&
        !process.argv.includes('--disable-jovo-debugger'),
      languageModelEnabled: true,
      languageModelPath: './models',
      debuggerJsonPath: './debugger.json',
      ignoredProperties: ['$app', '$handleRequest', '$platform'],
    };
  }

  install(parent: Extensible): void {
    if (!(parent instanceof App)) {
      throw new InvalidParentError(this.constructor.name, App);
    }
    this.installDebuggerPlatform(parent);
  }

  private installDebuggerPlatform(app: App) {
    app.use(
      new CorePlatform({
        ...this.config.corePlatform,
        platform: 'jovo-debugger',
        plugins: [new NlpjsNlu(this.config.nlpjsNlu)],
      }),
    );
  }

  async initialize(app: App): Promise<void> {
    if (this.config.enabled === false) return;

    await this.connectToWebhook();
    if (!this.socket) {
      // TODO: implement error
      throw new Error();
    }

    this.socket.on(JovoDebuggerEvent.DebuggingAvailable, () => {
      return this.onDebuggingAvailable();
    });
    this.socket.on(JovoDebuggerEvent.DebuggerLanguageModelRequest, () => {
      return this.onDebuggerLanguageModelRequest();
    });
    this.socket.on(JovoDebuggerEvent.DebuggerRequest, (request: AnyObject) => {
      return this.onDebuggerRequest(app, request);
    });

    this.patchHandleRequestToIncludeUniqueId();
    this.patchPlatformsToCreateJovoAsProxy(app.platforms);
  }

  mount(parent: HandleRequest): Promise<void> | void {
    this.socket = parent.app.plugins.JovoDebugger?.socket;
    parent.middlewareCollection.use('request.start', (jovo) => {
      return this.onRequest(jovo);
    });
    parent.middlewareCollection.use('response.end', (jovo) => {
      return this.onResponse(jovo);
    });
  }

  emitUpdate(requestId: string | number, data: JovoUpdateData) {
    const payload: JovoDebuggerPayload<JovoUpdateData> = {
      requestId,
      data,
    };
    this.socket?.emit(JovoDebuggerEvent.AppJovoUpdate, payload);
  }

  private patchHandleRequestToIncludeUniqueId() {
    // this cannot be done in a middleware-hook because the debuggerRequestId is required when initializing the jovo instance
    // and that happens before the middlewares are executed
    const mount = HandleRequest.prototype.mount;
    HandleRequest.prototype.mount = function () {
      this.debuggerRequestId = uuidV4();
      return mount.call(this);
    };
  }

  private patchPlatformsToCreateJovoAsProxy(platforms: ReadonlyArray<Platform>) {
    platforms.forEach((platform) => {
      const createJovoFn = platform.createJovoInstance;
      // overwrite createJovoInstance to create a proxy and propagate all initial changes
      platform.createJovoInstance = (app, handleRequest) => {
        const jovo = createJovoFn.call(platform, app, handleRequest);
        // propagate initial values, might not be required, TBD
        for (const key in jovo) {
          const value = jovo[key as keyof Jovo];
          const isEmptyObject =
            typeof value === 'object' && !Array.isArray(value) && !Object.keys(value || {}).length;
          const isEmptyArray = Array.isArray(value) && !((value as unknown[]) || []).length;
          if (
            !jovo.hasOwnProperty(key) ||
            this.config.ignoredProperties.includes(key) ||
            !value ||
            isEmptyObject ||
            isEmptyArray
          ) {
            continue;
          }
          this.emitUpdate(handleRequest.debuggerRequestId, {
            key,
            value,
            path: key,
          });
        }
        return new Proxy(jovo, this.createProxyHandler(handleRequest));
      };
    });
  }

  private createProxyHandler<T extends AnyObject>(
    handleRequest: HandleRequest,
    path = '',
  ): ProxyHandler<T> {
    return {
      get: (target, key: string) => {
        // make __isProxy return true for all proxies with this handler
        if (key === '__isProxy') {
          return true;
        }
        // if the value is an object that is not null, not a Date nor a Jovo instance nor included in the ignored properties and no proxy
        if (
          typeof target[key] === 'object' &&
          target[key] !== null &&
          !(target[key] instanceof Date) &&
          !(target[key] instanceof Jovo) &&
          !this.config.ignoredProperties.includes(key) &&
          !target[key].__isProxy
        ) {
          // create the proxy for the value
          const proxy = new Proxy(
            target[key],
            this.createProxyHandler(handleRequest, path ? [path, key].join('.') : key),
          );

          // check if the property is writable, if it's not, return the proxy
          const propertyDescriptor = Object.getOwnPropertyDescriptor(target, key);
          if (!propertyDescriptor?.writable) {
            return proxy;
          }

          // otherwise overwrite the property and set it to the proxy
          (target as UnknownObject)[key] = proxy;
        }
        return target[key];
      },
      set: (target, key: string, value: unknown): boolean => {
        const previousValue = (target as UnknownObject)[key];
        (target as UnknownObject)[key] = value;
        // only emit changes
        if (!isEqual(previousValue, value)) {
          this.emitUpdate(handleRequest.debuggerRequestId, {
            key,
            value,
            path: path ? [path, key].join('.') : key,
          });
        }

        return true;
      },
    };
  }

  private onDebuggingAvailable(): void {
    if (!this.socket) {
      // TODO: implement error
      throw new Error();
    }

    // TODO: check if there is a better way and this is desired
    function propagateStreamAsLog(stream: Writable, socket: typeof Socket) {
      const originalWriteFn = stream.write;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      stream.write = function (chunk: Buffer, ...args: any[]) {
        socket.emit(JovoDebuggerEvent.AppConsoleLog, chunk.toString(), new Error().stack);
        return originalWriteFn.call(this, chunk, ...args);
      };
    }

    if (!this.hasOverriddenWrite) {
      propagateStreamAsLog(process.stdout, this.socket);
      propagateStreamAsLog(process.stderr, this.socket);
      this.hasOverriddenWrite = true;
    }
  }

  private async onDebuggerLanguageModelRequest(): Promise<void> {
    if (!this.config.languageModelEnabled) return;
    if (!this.config.languageModelPath || !this.config.debuggerJsonPath) {
      // TODO: determine what to do (warning or error or nothing)
      return;
    }
    if (!this.socket) {
      // eslint-disable-next-line no-console
      console.warn('Can not emit language-model: Socket is not available.');
      return;
    }
    // look for language-models
    try {
      const languageModel = await this.getLanguageModel();
      this.socket.emit(JovoDebuggerEvent.AppLanguageModelResponse, languageModel);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('Can not emit language-model: Could not retrieve language-model.');
    }
    // TODO implement sending debuggerConfig if that is required
  }

  private async getLanguageModel(): Promise<AnyObject> {
    const languageModel: AnyObject = {};
    const absoluteModelsPath = join(cwd(), this.config.languageModelPath);
    let files: string[] = [];
    try {
      files = await promises.readdir(absoluteModelsPath);
    } catch (e) {
      // TODO implement error handling
      throw new JovoError({ message: `Couldn't find models-directory at ${absoluteModelsPath}` });
    }
    const isValidFileRegex = /^.*([.]js(?:on)?)$/;
    for (let i = 0, len = files.length; i < len; i++) {
      const match = isValidFileRegex.exec(files[i]);
      if (!match) {
        continue;
      }
      const locale = files[i].substring(0, files[i].indexOf(match[1]));
      const absoluteFilePath = join(absoluteModelsPath, files[i]);
      if (match[1] === '.json') {
        try {
          const fileBuffer = await promises.readFile(absoluteFilePath);
          languageModel[locale] = JSON.parse(fileBuffer.toString());
        } catch (e) {
          // eslint-disable-next-line no-console
          console.error(e);
        }
      } else {
        languageModel[locale] = require(absoluteModelsPath);
      }
    }
    return languageModel;
  }

  private async onDebuggerRequest(app: App, request: AnyObject): Promise<void> {
    await app.handle(new MockServer(request));
  }

  private onRequest(jovo: Jovo) {
    if (!this.socket) {
      // TODO: implement error
      throw new Error();
    }
    const payload: JovoDebuggerPayload<JovoRequest> = {
      requestId: jovo.$handleRequest.debuggerRequestId,
      data: jovo.$request,
    };
    this.socket.emit(JovoDebuggerEvent.AppRequest, payload);
  }

  private onResponse(jovo: Jovo) {
    if (!this.socket) {
      // TODO: implement error
      throw new Error();
    }
    const payload: JovoDebuggerPayload = {
      requestId: jovo.$handleRequest.debuggerRequestId,
      data: jovo.$response,
    };
    this.socket.emit(JovoDebuggerEvent.AppResponse, payload);
  }

  private async connectToWebhook() {
    const webhookId = await this.retrieveLocalWebhookId();
    this.socket = connect(this.config.webhookUrl, {
      query: {
        id: webhookId,
        type: 'app',
      },
    });
    this.socket.on('connect_error', (error: Error) => {
      // TODO: improve handling
      // eslint-disable-next-line no-console
      console.error(error);
    });
  }

  private async retrieveLocalWebhookId(): Promise<string> {
    try {
      const homeConfigPath = join(this.getUserHomePath(), '.jovo/configv4');
      const homeConfigBuffer = await promises.readFile(homeConfigPath);
      const homeConfigData = JSON.parse(homeConfigBuffer.toString());
      if (homeConfigData?.webhook?.uuid) {
        return homeConfigData.webhook.uuid;
      }
      // TODO implement error
      throw new Error('Could not find webhook-id');
    } catch (e) {
      // TODO implement error
      throw new Error('Could not find webhook-id');
    }
  }

  private getUserHomePath(): string {
    const path = process.env[process.platform === 'win32' ? 'USERPROFILE' : 'HOME'];
    if (!path) {
      // TODO implement error
      throw new Error();
    }
    return path;
  }
}
