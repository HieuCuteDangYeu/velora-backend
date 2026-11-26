export class InvalidAppleTokenError extends Error {
  constructor() {
    super('Invalid Apple token');
    this.name = 'InvalidAppleTokenError';
  }
}
