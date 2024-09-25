import { join as pathJoin } from 'path';

export default {
  hostPrivateKeyFilePath: pathJoin(__dirname, '../id_rsa'),

  port: 8022,
  hostname: '172.29.237.87', // '127.0.0.1',

  allowedUser: Buffer.from('sergiu'),
  allowedPassword: Buffer.from('password'),

  // Parent of "/data" directory
  dataDirParent: pathJoin(__dirname, '..'),
}