import { Server, ServerConfig } from 'ssh2';
import { readFileSync } from 'fs';
import config from './config';
import connection from './controller';

const serverConfig: ServerConfig = {
  hostKeys: [
    readFileSync(config.hostPrivateKeyFilePath),
    // { key: readFileSync(config.hostPrivateKeyFilePath), passphrase: '' },
  ],
  banner: 'Upload-only server. Symlink-related actions are not supported.',
  ident: 'Home-SFTP-Server-Nodejs'
}
const server = new Server(serverConfig, connection);

server.listen(config.port, config.hostname, () => {
  const address = server.address();
  if (!address) {
    console.log(`SFTP Server is not listening...`);
  } else if (typeof address === 'string') {
    console.log(`SFTP Server is listening (${address})`)
  } else {
    console.log(`SFTP Server listening on port ${address.port}`)
  }
})