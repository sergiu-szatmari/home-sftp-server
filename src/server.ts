import { Server, ServerConfig } from 'ssh2';
import { readFileSync } from 'fs';
import { createServer as createWebServer } from 'http';
import { runPrerequisiteActions } from './utils';
import config from './config';
import connection from './controller';

// There are some things that should be taken care of before SFTP server
// initialization; This will be accomplished with the following function
runPrerequisiteActions();

const serverConfig: ServerConfig = {
  hostKeys: [
    readFileSync(config.hostPrivateKeyFilePath),
    // { key: readFileSync(config.hostPrivateKeyFilePath), passphrase: '' },
  ],
  banner: 'Upload-only server. Symlink-related actions are not supported.',
  ident: 'Home-SFTP-Server-Nodejs'
}
const server = new Server(serverConfig, connection);

server.listen(config.port.sftp, config.hostname, () => {
  const address = server.address();
  if (!address) {
    console.log(`SFTP Server is not listening...`);
  } else if (typeof address === 'string') {
    console.log(`SFTP Server is listening (${address})`)
  } else {
    console.log(`SFTP Server listening on port ${address.port}`)
  }
})

if (!config.allowWebHealthCheck) {
  console.log('Web server (Health Check) is DISABLED')
} else {
  const webServer = createWebServer((req, res) => {
    res.statusCode = 200;
    res.write('OK');
    return res.end(
      () => console.log(`[${new Date().toISOString()}][HTTP] Responded "200 OK" to HTTP Request @ ${req.url}`)
    );
  });
  
  webServer.listen(config.port.web, () => {
    console.log(`Web server (Health Check) listening on port ${config.port.web}`)
  });
}