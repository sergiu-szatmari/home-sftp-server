# home-sftp-server
Simple Node.js (S)FTP server implemented on top of _**ssh2**_ library for self-hosted environment.

## Prerequisites

- You need to generate a Public-Private key pair using `ssh-keygen -t rsa -b 2048`
- Adapt the `hostPrivateKeyFilePath` path in the `src/config.ts` file to point to the private key file
- Adapt the `dataDirParent` path in the `src/config.ts` file to point to the parent folder of `/data` directory where you want your server to save/serve files from

### Util documentation

- [ssh2 documentation](https://github.com/mscdex/ssh2/blob/master/README.md) &dash; explains SFTPServer constructor config options and params and overall behaviour

- [ssh2 SFTP Server events & actions](https://github.com/mscdex/ssh2/blob/master/SFTP.md) &dash; explains supported events, along with expected response types & handling methods