'use strict';

const fs = require('node:fs');
const https = require('node:https');
const dns = require('node:dns');
const { BlockList, isIP } = require('node:net');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const blocked = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 3],
])
  blocked.addSubnet(network, prefix);

function validateSourceUrl(value) {
  const url = new URL(value);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    (url.port && url.port !== '443') ||
    isIP(url.hostname) ||
    url.hostname.includes(':') ||
    !url.hostname.includes('.') ||
    url.hostname.endsWith('.local')
  ) {
    throw new Error(
      'Import source must be a public HTTPS hostname without credentials or a custom port',
    );
  }
  return url;
}

function publicLookup(hostname, options, callback) {
  // Pin the validated address for this connection; revalidate each redirect.
  dns.lookup(hostname, { family: 4, all: true }, (error, addresses) => {
    if (
      error ||
      !addresses?.length ||
      addresses.some(({ address }) => blocked.check(address, 'ipv4'))
    ) {
      callback(
        new Error(
          'Import source DNS must resolve only to public IPv4 addresses',
        ),
      );
      return;
    }
    if (options.all) callback(null, addresses);
    else callback(null, addresses[0].address, 4);
  });
}

async function stageSource(
  value,
  destination,
  { redirects = 3, maxBytes = 512 * 1024 * 1024 } = {},
) {
  const url = validateSourceUrl(value);
  const response = await new Promise((resolve, reject) => {
    const request = https.get(
      url,
      {
        lookup: publicLookup,
        signal: AbortSignal.timeout(180_000),
        headers: { 'User-Agent': 'Velora-Importer' },
      },
      resolve,
    );
    request.on('error', () =>
      reject(new Error('Import source download failed')),
    );
  });
  if (
    response.statusCode >= 300 &&
    response.statusCode < 400 &&
    response.headers.location
  ) {
    response.resume();
    if (!redirects) throw new Error('Import source exceeded redirect limit');
    return stageSource(
      new URL(response.headers.location, url).href,
      destination,
      { redirects: redirects - 1, maxBytes },
    );
  }
  if (
    response.statusCode !== 200 ||
    Number(response.headers['content-length'] || 0) > maxBytes
  ) {
    response.destroy();
    throw new Error('Import source must return HTTP 200 within the size limit');
  }
  let bytes = 0;
  const limit = new Transform({
    transform(chunk, encoding, callback) {
      bytes += chunk.length;
      callback(
        bytes > maxBytes
          ? new Error('Import source exceeded size limit')
          : null,
        chunk,
      );
    },
  });
  await pipeline(
    response,
    limit,
    fs.createWriteStream(destination, { flags: 'wx', mode: 0o600 }),
  );
  return { bytes };
}

module.exports = { stageSource, validateSourceUrl, publicLookup };
