const https = require('https');
const { XMLParser } = require('fast-xml-parser');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const fetchUrl = (url, maxRedirects = 5) => {
  return new Promise((resolve, reject) => {
    if (maxRedirects === 0) {
      return reject(new Error(`Too many redirects for ${url}`));
    }
    
    https.get(url, (res) => {
      const { statusCode } = res;
      
      if (statusCode >= 300 && statusCode < 400 && res.headers.location) {
        // Handle redirect
        const redirectUrl = new URL(res.headers.location, url).href;
        return fetchUrl(redirectUrl, maxRedirects - 1).then(resolve).catch(reject);
      }
      
      if (statusCode !== 200) {
        res.resume();
        return reject(new Error(`Request Failed for ${url}. Status Code: ${statusCode}`));
      }
      
      let rawData = '';
      res.on('data', (chunk) => { rawData += chunk; });
      res.on('end', () => {
        resolve(rawData);
      });
    }).on('error', (e) => {
      reject(e);
    });
  });
};

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  isArray: (name) => ['url'].includes(name),
});

const fetchSitemapIndex = async (baseUrl) => {
  try {
    const sitemapUrl = baseUrl.endsWith('/sitemap.xml') ? baseUrl : `${baseUrl}/sitemap.xml`;
    const xmlData = await fetchUrl(sitemapUrl);
    const result = parser.parse(xmlData);
    
    if (result && result.sitemapindex && result.sitemapindex.sitemap) {
      const sitemaps = Array.isArray(result.sitemapindex.sitemap) 
        ? result.sitemapindex.sitemap 
        : [result.sitemapindex.sitemap];
      
      return sitemaps.map(s => s.loc);
    }
    return [];
  } catch (error) {
    console.error(`Error fetching sitemap index from ${baseUrl}:`, error.message);
    return [];
  }
};

const fetchEpisodeSitemap = async (url) => {
  try {
    const xmlData = await fetchUrl(url);
    const result = parser.parse(xmlData);
    
    if (!result || !result.urlset || !result.urlset.url) {
      return [];
    }
    
    const episodes = [];
    for (const urlEntry of result.urlset.url) {
      try {
        const playerUrl = urlEntry.loc;
        if (!playerUrl) continue;
        
        // Extract seriesSlug and episodeNumber from playerUrl
        // https://narto-drama.com/detail/watch/{slug}/{episode}?lang=id-ID
        const match = playerUrl.match(/\/detail\/watch\/([^\/]+)\/([^\/?]+)/);
        if (!match) continue;
        
        const seriesSlug = match[1];
        const episodeNumber = parseInt(match[2], 10) || match[2]; // fallback to string if not int
        
        const imageInfo = urlEntry['image:image'] || {};
        const videoInfo = urlEntry['video:video'] || {};
        
        episodes.push({
          seriesSlug,
          episodeNumber: typeof episodeNumber === 'number' ? episodeNumber : Number(episodeNumber),
          seriesTitle: imageInfo['image:title'] || '',
          seriesDescription: imageInfo['image:caption'] || '',
          episodeTitle: videoInfo['video:title'] || '',
          episodeDescription: videoInfo['video:description'] || '',
          posterUrl: imageInfo['image:loc'] || videoInfo['video:thumbnail_loc'] || '',
          playerUrl,
          publishedAt: videoInfo['video:publication_date'] || '',
          lastModified: urlEntry.lastmod || '',
        });
      } catch (e) {
        console.error(`Error parsing episode entry in ${url}:`, e.message);
      }
    }
    return episodes;
  } catch (error) {
    console.error(`Error fetching episode sitemap from ${url}:`, error.message);
    return [];
  }
};

const crawlAllEpisodes = async (options = {}) => {
  const {
    sitemapUrls = [],
    concurrency = 3,
    delayMs = 500,
  } = options;

  if (sitemapUrls.length === 0) {
    console.log('No episode sitemaps provided. Aborting.');
    return [];
  }

  console.log(`Crawling ${sitemapUrls.length} episode sitemaps (concurrency=${concurrency})...`);
  const allEpisodes = [];

  for (let i = 0; i < sitemapUrls.length; i += concurrency) {
    const batch = sitemapUrls.slice(i, i + concurrency);
    const batchNum = Math.floor(i / concurrency) + 1;
    const totalBatches = Math.ceil(sitemapUrls.length / concurrency);

    const promises = batch.map((url) => fetchEpisodeSitemap(url));
    const results = await Promise.allSettled(promises);

    let batchTotal = 0;
    results.forEach((result, idx) => {
      if (result.status === 'fulfilled') {
        allEpisodes.push(...result.value);
        batchTotal += result.value.length;
      } else {
        console.error(`  Failed: ${batch[idx]} — ${result.reason?.message || result.reason}`);
      }
    });

    process.stdout.write(`\r  Batch ${batchNum}/${totalBatches} — ${allEpisodes.length} episodes so far`);

    if (i + concurrency < sitemapUrls.length) {
      await sleep(delayMs);
    }
  }

  console.log(`\nCrawl complete: ${allEpisodes.length} episodes from ${sitemapUrls.length} sitemaps`);
  return allEpisodes;
};

module.exports = {
  fetchSitemapIndex,
  fetchEpisodeSitemap,
  crawlAllEpisodes,
};
