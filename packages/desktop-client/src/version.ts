/** Version of this installed client package, including any dev/pre-release suffix. */
export const CLIENT_VERSION: string = (require('../package.json') as { version: string }).version;
