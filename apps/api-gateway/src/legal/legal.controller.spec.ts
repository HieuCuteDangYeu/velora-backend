import { LegalController } from './legal.controller';
import { privacyPolicyHtml, termsHtml } from './legal-pages';

describe('LegalController', () => {
  const controller = new LegalController();

  it('serves a complete privacy policy page', () => {
    const html = controller.privacy();
    expect(html).toMatch(/^<!doctype html>/);
    expect(html).toContain('<title>Privacy Policy · Velora</title>');
    for (const processor of ['Cloudflare', 'Firebase', 'Groq', 'Resend']) {
      expect(html).toContain(processor);
    }
  });

  it('serves terms that state the moderation rules App Review asks for', () => {
    const html = controller.terms();
    expect(html).toContain('No tolerance for objectionable content');
    expect(html).toContain('block any user');
    expect(html).toContain('within 24 hours');
  });

  it('escapes the contact address', () => {
    expect(privacyPolicyHtml('a<b>@example.com')).toContain(
      'a&#60;b&#62;@example.com',
    );
    expect(termsHtml('x"y@example.com')).not.toContain('x"y@');
  });
});
