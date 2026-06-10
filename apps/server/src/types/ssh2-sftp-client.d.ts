declare module "ssh2-sftp-client" {
  interface ConnectOptions {
    host: string;
    port?: number;
    username?: string;
    password?: string;
    privateKey?: Buffer | string;
  }

  export default class SftpClient {
    connect(options: ConnectOptions): Promise<void>;
    mkdir(remotePath: string, recursive?: boolean): Promise<unknown>;
    realPath(remotePath: string): Promise<string>;
    fastPut(localPath: string, remotePath: string): Promise<void>;
    fastGet(remotePath: string, localPath: string): Promise<void>;
    end(): Promise<void>;
  }
}
