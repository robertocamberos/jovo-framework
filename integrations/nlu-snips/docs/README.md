---
title: 'Snips NLU Integration'
excerpt: 'Turn raw text into structured meaning with the Jovo Framework integration for the open source natural language understanding service Snips NLU.'
url: 'https://www.jovo.tech/marketplace/nlu-snips'
---

# Snips NLU Integration

Turn raw text into structured meaning with the Jovo Framework integration for the open source natural language understanding service Snips NLU.

## Introduction

[Snips NLU](https://github.com/snipsco/snips-nlu) is an open source [natural language understanding (NLU)](https://www.jovo.tech/docs/nlu) library.

Since it is an open source service, you can host Snips NLU on your own servers without any external API calls. You can learn how to set up a server in the [official Snips NLU documentation](https://snips-nlu.readthedocs.io/en/latest/). Jovo also offers an open source repository repository that can be used to run a Snips NLU Python server that supports [dynamic entities](#dynamic-entities): [jovotech/snips-nlu-server](https://github.com/jovotech/snips-nlu-server).

You can use the Jovo Snips NLU integration for projects where you receive raw text input that needs to be translated into structured meaning to work with the Jovo intent structure. Platforms like the [Jovo Core Platform](https://www.jovo.tech/marketplace/platform-core) (e.g. in conjunction with the [Jovo Web Client](https://www.jovo.tech/marketplace/jovo-client-web)), [Facebook Messenger](https://www.jovo.tech/marketplace/platform-facebookmessenger), and [Google Business Messages](https://www.jovo.tech/marketplace/platform-googlebusiness) are some examples where this would work.

## Installation

You can install the plugin like this:

```sh
$ npm install @jovotech/nlu-snips
```

NLU plugins can be added to Jovo platform integrations. Here is an example how it can be added to the Jovo Core Platform in `app.ts`:

```typescript
import { CorePlatform } from '@jovotech/platform-core';
import { SnipsNlu } from '@jovotech/nlu-snips';

// ...

const app = new App({
  plugins: [
    new CorePlatform({
      plugins: [new SnipsNlu()],
    }),
    // ...
  ],
});
```

## Configuration

The following configurations can be added:

```typescript
new SnipsNlu({
  serverUrl: 'http://localhost:5000/',
  serverPath: '/engine/parse',
  fallbackLanguage: 'en',
  engineId: '',
  dynamicEntities: { /* ... */ },
}),
```

- `serverUrl` and `serverPath`: The API endpoint where the Snips NLU server can be reached.
- `fallbackLanguage`: The language that gets used if the request does not come with a language property. Default: `en`.
- `engineId`: This ID gets passed to the Snips NLU server. Default: Random `uuid`.
- `dynamicEntities`: [See more information about dynamic entities below](#dynamic-entities).

## Entities

You can access Snips slots by using the `$entities` property. You can learn more in the [Jovo Model](https://www.jovo.tech/docs/models) and the [`$entities` documentation](https://www.jovo.tech/docs/entities).

The Snips slot values are translated into the following Jovo entity properties:

```typescript
{
  value: rawValue, // what the user said
  resolved: value.value, // the resolved value
  id: value.value, // same as resolved, since Snips doesn't support IDs
  native: { /* raw API response for this slot */ }
}
```

You can learn more about the Snips slot format in the [official Snips documentation](https://snips-nlu.readthedocs.io/en/latest/data_model.html#slot).

## Dynamic Entities

It is possible to set up Snips NLU to work with [dynamic entities](https://www.jovo.tech/docs/entities#dynamic-entities).

The Jovo Snips NLU integration automatically parses the entities that are added to the `listen` object of the [output template](https://www.jovo.tech/docs/output-templates), and sends them to the Snips NLU server along with the session ID.

The Snips NLU server then trains an updated model just for the intents that use the `entities` from `listen`.

This is the configuration for `dynamicEntities`:

```typescript
new SnipsNlu({
  // ...
  dynamicEntities: {
    enabled: false,
    serverPath: '/engine/train/dynamic-entities',
    passModels: true;

    // Either use models directory or import model files and
    modelsDirectory: 'models';
    models: [ en ];
  },
}),
```

- `enabled`: Setting this to `true` will enable the training of dynamic entities.
- `serverPath`: This is the endpoint of the server that handles the training. Uses the same base `serverUrl` as the [main configuration](#configuration).
- `passModels`: Since the server trains a new model that includes only the intents that use the dynamic entities, it needs access to the existing language model. You can either modify the server to access them, or pass the models using this NLU integration. If the latter, there are two options:
  - `modelsDirectory`: Reference the folder that includes all the model files. If you're deploying the app, make sure that the models files are included in the bundle.
  - `models`: Import the model files and reference them here. This property is prioritized over `modelsDirectory` if both are used.
