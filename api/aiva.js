// Vercel-serverfunktion för AIVA. Nycklar läggs som miljövariabler, aldrig i frontend.
// GEMINI_API_KEY        (krävs)  nyckel från Google AI Studio
// GEMINI_IMAGE_MODEL    (valfri) standard: gemini-2.5-flash-image
// SHOPIFY_CATALOG_URL   (krävs)  sök-endpoint för Shopifys produktkatalog
// SHOPIFY_CATALOG_TOKEN (krävs)  åtkomsttoken för katalogen
// ALLOWED_ORIGIN        (rekommenderad) t.ex. https://www.dinsida.se

const MODEL = process.env.GEMINI_IMAGE_MODEL || "gemini-2.5-flash-image";

const CATEGORIES = {
  "Vardagsrum": ["soffa", "matta", "soffbord", "golvlampa", "fåtölj", "tv-bänk"],
  "Sovrum": ["säng", "nattduksbord", "matta", "sänglampa", "byrå", "fåtölj"],
  "Kök/matplats": ["matbord", "matstolar", "pendellampa", "matta", "skänk", "barstol"],
  "Hall": ["skobänk", "hallspegel", "klädhängare", "matta", "konsolbord", "lampa"],
  "Hemmakontor": ["skrivbord", "kontorsstol", "bokhylla", "skrivbordslampa", "matta", "förvaring"],
  "Barnrum": ["barnsäng", "matta", "förvaring", "lampa", "skrivbord", "pall"],
};

function cors(req, res) {
  res.setHeader("Access-Control-Allow-Origin", process.env.ALLOWED_ORIGIN || "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

// Hämtar en produkt per kategori inom budgeten (fördelad lika per möbel).
// OBS: svarsformatet nedan är ett antagande. Justera mapProduct() efter den
// katalog-API-dokumentation du har tillgång till.
async function searchOne(term, brief, perItemBudget) {
  const q = [term, brief.style, brief.color, brief.materials].filter(Boolean).join(" ");
  const url = new URL(process.env.SHOPIFY_CATALOG_URL);
  url.searchParams.set("query", q);
  url.searchParams.set("limit", "5");
  const r = await fetch(url, { headers: { Authorization: "Bearer " + process.env.SHOPIFY_CATALOG_TOKEN } });
  if (!r.ok) throw new Error("Produktsökningen misslyckades (" + r.status + ")");
  const data = await r.json();
  const items = (data.products || data.results || data.items || []).map(mapProduct).filter((p) => p.url && p.image);
  const fit = items.filter((p) => !p.price || p.price <= perItemBudget);
  return (fit[0] || items[0]) && { ...(fit[0] || items[0]), category: term };
}

function mapProduct(x) {
  return {
    title: x.title || x.name,
    price: Number(x.price?.amount ?? x.price ?? x.priceRange?.min?.amount ?? 0),
    currency: x.price?.currency || x.currency || x.priceRange?.min?.currencyCode || "SEK",
    image: x.image?.url || x.images?.[0]?.url || x.image || x.imageUrl,
    url: x.url || x.productUrl || x.onlineStoreUrl, // ska vara produktsidan, inte butikens startsida
    shop: x.shop?.name || x.vendor || x.shopName,
    description: x.description,
  };
}

async function findProducts(brief) {
  const terms = CATEGORIES[brief.room] || CATEGORIES["Vardagsrum"];
  const per = (Number(brief.budget) || 25000) / terms.length;
  const found = await Promise.all(terms.map((t) => searchOne(t, brief, per).catch(() => null)));
  return found.filter(Boolean).slice(0, 6);
}

function parseDataUrl(d) {
  const m = /^data:(image\/[\w+.-]+);base64,(.+)$/.exec(d || "");
  if (!m) throw new Error("Ogiltig bild.");
  return { inlineData: { mimeType: m[1], data: m[2] } };
}

async function fetchImagePart(url) {
  try {
    const r = await fetch(url);
    if (!r.ok) return null;
    const type = (r.headers.get("content-type") || "").split(";")[0];
    if (!type.startsWith("image/")) return null;
    return { inlineData: { mimeType: type, data: Buffer.from(await r.arrayBuffer()).toString("base64") } };
  } catch { return null; }
}

function buildPrompt({ brief, products, instruction }) {
  const list = products.map((p, i) => `${i + 1}. ${p.title} (${p.category}), bild ${i + 2} i ordningen`).join("\n");
  return [
    `Du är inredningsarkitekt. Möblera rummet på det första fotot (${brief.room}). Stil: ${brief.style}. Färgtema: ${brief.color || "valfritt"}. Material: ${brief.materials || "valfritt"}.`,
    `STRIKTA REGLER:`,
    `- Ändra ALDRIG rummets väggar, golv, tak, fönster, dörrar eller kameravinkel. Allt som är byggt i rummet ska se exakt likadant ut.`,
    `- Placera endast dessa verkliga produkter, och låt dem likna produktbilderna i form, färg och proportioner. Lägg inte till andra större möbler:\n${list}`,
    `- Skala möblerna realistiskt mot rummets storlek. Fotorealistisk bild, naturligt ljus och skuggor.`,
    instruction
      ? `ÄNDRING FRÅN KUNDEN: "${instruction}". Utgå från den senaste versionen (andra bilden) och ändra bara det kunden bad om.`
      : `Skapa första versionen.`,
  ].join("\n");
}

async function generate(body) {
  const { photo, brief, products = [], instruction, current } = body;
  const parts = [{ text: buildPrompt({ brief, products, instruction }) }];
  parts.push(parseDataUrl(current || photo)); // bas: senaste versionen vid ändring, annars originalfotot
  if (current) parts.push(parseDataUrl(photo)); // originalfoto som referens för fasta delar
  const refs = await Promise.all(products.slice(0, 6).map((p) => fetchImagePart(p.image)));
  refs.forEach((x) => x && parts.push(x));

  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": process.env.GEMINI_API_KEY },
    body: JSON.stringify({ contents: [{ role: "user", parts }], generationConfig: { responseModalities: ["IMAGE", "TEXT"] } }),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error?.message || "Bildgenereringen misslyckades.");
  const img = data.candidates?.[0]?.content?.parts?.find((p) => p.inlineData || p.inline_data);
  const d = img && (img.inlineData || img.inline_data);
  if (!d) throw new Error("AI:n returnerade ingen bild. Försök igen eller formulera om ändringen.");
  return `data:${d.mimeType || d.mime_type};base64,${d.data}`;
}

export default async function handler(req, res) {
  cors(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Endast POST." });
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};
    if (body.action === "products") return res.json({ products: await findProducts(body.brief || {}) });
    if (body.action === "generate") return res.json({ image: await generate(body) });
    return res.status(400).json({ error: "Okänd åtgärd." });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

export const config = { maxDuration: 60, api: { bodyParser: { sizeLimit: "12mb" } } };
