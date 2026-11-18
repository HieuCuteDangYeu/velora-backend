// Embeds a list of texts with the same TEI service ai-service uses, so the recall ranker can be
// scored offline against real vectors. Reads a JSON array of strings on stdin and prints a JSON
// object {text: vector}. Run it where TEI_EMBEDDING_BASE_URL resolves, for example inside the
// ai-service container (see eval/rag/README.md, "Conversation recall").
const base = (process.env.TEI_EMBEDDING_BASE_URL || '').replace(/\/+$/, '');
if (!base) {
  console.error('TEI_EMBEDDING_BASE_URL is not set');
  process.exit(2);
}
const CONCURRENCY = 2;

(async () => {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  const texts = [...new Set(JSON.parse(raw))];
  const vectors = {};
  let cursor = 0;
  const worker = async () => {
    while (cursor < texts.length) {
      const text = texts[cursor++];
      const response = await fetch(`${base}/embed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ inputs: [text], normalize: true }),
      });
      if (!response.ok) throw new Error(`TEI ${response.status}`);
      vectors[text] = (await response.json())[0];
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  process.stdout.write(JSON.stringify(vectors));
})().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
