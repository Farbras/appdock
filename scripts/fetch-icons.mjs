import fs from "node:fs";
const apps = JSON.parse(fs.readFileSync("catalog/apps.json"));
fs.mkdirSync("public/icons", { recursive: true });
const ids = [...new Set(apps.map((a) => a.icon))];
let next = 0;
let ok = 0;
await Promise.all(
  Array.from({ length: 6 }, async () => {
    while (next < ids.length) {
      const id = ids[next++];
      try {
        const r = await fetch(
          `https://cdn.jsdelivr.net/npm/simple-icons@latest/icons/${id}.svg`,
        );
        if (!r.ok) continue;
        const body = await r.text();
        if (!body.includes("<svg")) continue;
        fs.writeFileSync(`public/icons/${id}.svg`, body);
        ok++;
      } catch {}
    }
  }),
);
fs.writeFileSync(
  "public/icons/LICENSE.txt",
  "Brand glyphs from Simple Icons, CC0 1.0 Universal. https://github.com/simple-icons/simple-icons\nTrademarks belong to their respective owners. Fallback letter marks are rendered locally.\n",
);
console.log(`${ok} local brand glyphs`);
