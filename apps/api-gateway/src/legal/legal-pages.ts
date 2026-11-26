/** Where users send privacy requests, reports and questions. */
export const LEGAL_CONTACT_EMAIL = 'leanhquan1702@gmail.com';

const LAST_UPDATED = '26 November 2026';

const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

const page = (title: string, body: string) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} · Velora</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; font: 16px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #fffaf5; color: #1f1a17; }
  main { max-width: 720px; margin: 0 auto; padding: 32px 20px 64px; }
  h1 { font-size: 1.8rem; margin: 0 0 4px; }
  h2 { font-size: 1.15rem; margin: 28px 0 8px; }
  p, li { margin: 6px 0; }
  .meta { color: #6b625c; margin-bottom: 24px; }
  a { color: #c2410c; }
  @media (prefers-color-scheme: dark) { body { background: #17130f; color: #f4ede6; } .meta { color: #b3a89f; } a { color: #fb923c; } }
</style>
</head>
<body><main>
<h1>${title}</h1>
<p class="meta">Last updated: ${LAST_UPDATED}</p>
${body}
</main></body>
</html>`;

export const privacyPolicyHtml = (contactEmail: string) => {
  const contact = escapeHtml(contactEmail);
  return page(
    'Privacy Policy',
    `<p>Velora is a messaging, calling and short-video app built as a university project. This policy explains what we collect, why, who processes it, and the choices you have.</p>

<h2>What we collect</h2>
<ul>
<li><strong>Account:</strong> e-mail address, password (stored only as a hash), name, username and profile photo. If you sign in with Google or Apple, we receive your e-mail address and an account identifier from that provider; with Apple you may choose to share a private relay address instead of your real e-mail.</li>
<li><strong>Content you create:</strong> messages, photos, videos and files you send, reactions, replies, reels, comments and the groups you create or join. Message text is encrypted at rest on our servers.</li>
<li><strong>Calls:</strong> who called whom, when, how long the call lasted and how it ended. Audio and video pass through our media servers in real time and are not recorded.</li>
<li><strong>Social graph and status:</strong> friends, friend requests, blocked accounts, online status, typing indicators and read receipts.</li>
<li><strong>Device and diagnostics:</strong> push notification tokens, app version, platform, and technical call-quality data (for example packet loss and connection set-up times) used to find and fix problems.</li>
<li><strong>Usage of reels:</strong> which reels you watch and interact with, used to recommend reels.</li>
</ul>

<h2>How we use it</h2>
<ul>
<li>To provide the service: deliver messages and calls, send notifications, show reels, keep your account secure.</li>
<li>To keep the service reliable: monitor errors and performance and investigate failures.</li>
<li>To answer messages you send to the Velora AI assistant.</li>
<li>To enforce our Terms of Use and respond to reports of abuse.</li>
</ul>
<p>We do not sell your data, show advertising, or track you across other companies' apps or websites.</p>

<h2>Who processes data for us</h2>
<ul>
<li><strong>Cloudflare</strong>: network delivery and storage of media files.</li>
<li><strong>Google Firebase Cloud Messaging</strong> and <strong>Apple Push Notification service</strong>: delivering notifications and incoming-call alerts.</li>
<li><strong>Google</strong> and <strong>Apple</strong>: signing in, if you choose those options.</li>
<li><strong>Groq</strong>: generating answers when you chat with the Velora AI assistant. It receives the messages you send to the assistant and the context needed to answer them, not your other conversations.</li>
<li><strong>Resend</strong>: sending account e-mails such as verification and password reset.</li>
</ul>
<p>Our servers are located in Vietnam, with a backup copy of the database and server logs held in France.</p>

<h2>How long we keep data</h2>
<p>Account data and content are kept while your account exists. Call-quality diagnostics are deleted automatically after a limited period. Backups are overwritten on a rolling basis.</p>

<h2>Your choices</h2>
<ul>
<li>You can edit your profile, block people, recall messages you sent, and turn notifications off in your device settings.</li>
<li>You can ask us to access, correct or delete your account and data by writing to <a href="mailto:${contact}">${contact}</a>. We answer within 30 days.</li>
</ul>

<h2>Children</h2>
<p>Velora is not intended for children under 13, and we do not knowingly collect their data.</p>

<h2>Changes</h2>
<p>If this policy changes, we will update the date above and, for important changes, tell you in the app.</p>

<h2>Contact</h2>
<p><a href="mailto:${contact}">${contact}</a></p>`,
  );
};

export const termsHtml = (contactEmail: string) => {
  const contact = escapeHtml(contactEmail);
  return page(
    'Terms of Use',
    `<p>By creating an account or using Velora you agree to these terms and to our <a href="/legal/privacy">Privacy Policy</a>.</p>

<h2>Your account</h2>
<p>You must be at least 13 years old. Keep your sign-in details safe; you are responsible for activity on your account.</p>

<h2>No tolerance for objectionable content or abusive users</h2>
<p>You must not post, send or share content that is illegal, hateful, harassing, threatening, sexually explicit, violent, or that infringes someone else's rights, and you must not impersonate others, spam, or try to break the service.</p>
<ul>
<li>You can block any user at any time from their profile.</li>
<li>You can report content or users to <a href="mailto:${contact}">${contact}</a>. We review reports within 24 hours, remove content that breaks these terms, and suspend or ban the accounts responsible.</li>
</ul>

<h2>Your content</h2>
<p>You keep ownership of what you post. You give Velora permission to store, process and show it to the people you share it with, only to run the service.</p>

<h2>The service</h2>
<p>Velora is a student project offered free of charge and "as is". It may change, be interrupted, or end. We are not liable for indirect losses arising from its use, to the extent the law allows.</p>

<h2>Ending your use</h2>
<p>You may stop using Velora at any time and ask us to delete your account. We may suspend accounts that break these terms.</p>

<h2>Contact</h2>
<p><a href="mailto:${contact}">${contact}</a></p>`,
  );
};
