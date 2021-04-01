import { execAsync, JovoCliError } from '@jovotech/cli-core';

export * from './Interfaces';
export * from './Paths';

export async function checkForGactionsCli() {
  try {
    await execAsync('gactions version');
  } catch (err) {
    throw new JovoCliError(
      'Jovo requires gactions CLI.',
      'GoogleAssistantCli',
      'Install the gactions CLI following this guide: ' +
        'https://developers.google.com/assistant/conversational/quickstart#install_the_gactions_command-line_tool',
    );
  }
}

/**
 * Tries to parse the provided error message for standard errors.
 * @param errorMessage - Error message.
 */
export function getGactionsError(errorMessage: string): JovoCliError {
  // ToDo: Check for different errors.
  if (errorMessage.includes('command requires authentication')) {
    throw new JovoCliError(
      'Missing authentication.',
      'GoogleAssistantCli',
      'Try to run "gactions login" first.',
    );
  }

  throw new JovoCliError(errorMessage, 'GoogleAssistantCli');
}
