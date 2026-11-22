export class AccountBannedError extends Error {
  constructor() {
    super('This account has been banned.');
    this.name = 'AccountBannedError';
  }
}
