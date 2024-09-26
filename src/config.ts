import { join as pathJoin } from 'path';

export default {
  hostPrivateKeyFilePath: pathJoin(__dirname, '../id_rsa'),

  port: {
    sftp: 8022,
    web: 8080,
  },
  hostname: '172.29.237.87',
  // hostname: '0.0.0.0',
  // hostname: '127.0.0.1',

  allowedUser: Buffer.from('sergiu'),
  allowedPassword: Buffer.from('password'),

  // Name of directory mapped to SFTP file system
  dataDirName: 'data',
  
  // Parent of "/[dataDirName]" directory
  dataDirParent: pathJoin(__dirname, '..'),

  // Skips/creates a web server used for health checks
  allowWebHealthCheck: false,
}