import { safeStorage } from 'electron'
import { AppError } from '../../domain/errors/app-error'
export class CredentialVault {
  async available(): Promise<boolean> {
    return safeStorage.isAsyncEncryptionAvailable()
  }
  async encrypt(secret: string): Promise<string> {
    if (!(await this.available()))
      throw new AppError(
        'UNSUPPORTED_OPERATION',
        'Windows secure storage is unavailable.',
        'Leave “Remember credentials” off.',
      )
    return (await safeStorage.encryptStringAsync(secret)).toString('base64')
  }
  async decrypt(secret: string): Promise<string> {
    if (!(await this.available()))
      throw new AppError('UNSUPPORTED_OPERATION', 'Windows secure storage is unavailable.')
    return (await safeStorage.decryptStringAsync(Buffer.from(secret, 'base64'))).result
  }
}
