/* 日本地図データ生成スクリプト（サイトの実行には不要。地図を作り直すときだけ使う）
 *
 * Natural Earth「Admin 1 – States, Provinces」(1:10m, パブリックドメイン) から
 * 47都道府県を取り出し、SVG パスにして data/japan-map.json を書き出す。
 *
 * 使い方:
 *   curl -L -o ne_admin1.geojson \
 *     https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_admin_1_states_provinces.geojson
 *   npm i --no-save mapshaper
 *   node tools/build-map.mjs ne_admin1.geojson
 *
 * 加工内容:
 *   - 遠方の小島を除外（沖縄県は東経128.4度以東=大東諸島と、NE で沖縄県に誤分類されている奄美群島。
 *     それ以外は北緯30度未満=奄美・小笠原など）
 *   - 面積25km²未満の島を除外（地図の見やすさ優先）
 *   - ランベルト正角円錐図法で投影し、境界を共有したまま簡略化
 *   - 沖縄県は左上の別枠（インセット）に移動。宮古・八重山は本島寄りに詰めて配置
 *   - 「現地で食べた」マーカー用に、各県の内部点を求める
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const src = process.argv[2];
if (!src) {
  console.error("usage: node tools/build-map.mjs <ne_10m_admin_1_states_provinces.geojson>");
  process.exit(1);
}
const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data", "japan-map.json");

const tmp = mkdtempSync(path.join(tmpdir(), "jfm-map-"));
const projPath = path.join(tmp, "proj.geojson");
const ptsPath = path.join(tmp, "pts.geojson");

// mapshaper は実行ディレクトリかリポジトリの node_modules から探す（npm i --no-save mapshaper）
function resolveMapshaper() {
  for (const base of [process.cwd(), path.dirname(fileURLToPath(import.meta.url))]) {
    try { return createRequire(path.join(base, "noop.js")).resolve("mapshaper/bin/mapshaper"); } catch { /* next */ }
  }
  console.error("mapshaper が見つかりません。先に `npm i --no-save mapshaper` を実行してください。");
  process.exit(1);
}

// シェルを通さず node で直接起動する（Windows でも引数のクォートが崩れない）
execFileSync(process.execPath, [
  resolveMapshaper(), src,
  "-filter", 'adm0_a3=="JPN"',
  "-each", "code=iso_3166_2.slice(3)",
  "-filter-fields", "code",
  "-explode",
  "-each", "cx=this.centroidX, cy=this.centroidY, a=this.area",
  "-filter", '(code=="47" && cx < 128.4) || (code!="47" && cy >= 30 && cx < 146.5)',
  "-filter", "a > 25e6",
  // 宮古・八重山を沖縄本島の近くへ寄せ、インセット枠をコンパクトにする
  "-affine", "shift=1.8,0.9", 'where=code=="47" && cx < 126',
  "-dissolve", "code",
  "-proj", "+proj=lcc +lat_1=33 +lat_2=44 +lat_0=37 +lon_0=137 +datum=WGS84 +units=m",
  "-simplify", "20%", "keep-shapes",
  "-o", projPath,
  "-points", "inner",
  "-o", ptsPath,
], { stdio: "inherit" });

const shapes = JSON.parse(readFileSync(projPath, "utf8")).features;
const points = JSON.parse(readFileSync(ptsPath, "utf8")).features;
rmSync(tmp, { recursive: true, force: true });

const rings = (g) => (g.type === "Polygon" ? g.coordinates : g.coordinates.flat());
function bbox(features) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const f of features) for (const ring of rings(f.geometry)) for (const [x, y] of ring) {
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  return { x0, y0, x1, y1 };
}

const OKINAWA = "47";
const main = bbox(shapes.filter((f) => f.properties.code !== OKINAWA));
const oki = bbox(shapes.filter((f) => f.properties.code === OKINAWA));

const WIDTH = 1000, PAD = 12;
const s = WIDTH / (main.x1 - main.x0);
const height = Math.round((main.y1 - main.y0) * s + PAD * 2);
const width = WIDTH + PAD * 2;

// 沖縄インセット: 本土より少し拡大して左上に置く
const INSET_SCALE = 2.0, INSET_PAD = 14;
const si = s * INSET_SCALE;
const inset = {
  code: OKINAWA, // 枠内のどこをタップしても沖縄県として扱う
  x: PAD,
  y: PAD,
  w: Math.round((oki.x1 - oki.x0) * si + INSET_PAD * 2),
  h: Math.round((oki.y1 - oki.y0) * si + INSET_PAD * 2),
};

function transformFor(code) {
  if (code === OKINAWA) {
    return ([x, y]) => [inset.x + INSET_PAD + (x - oki.x0) * si, inset.y + INSET_PAD + (oki.y1 - y) * si];
  }
  return ([x, y]) => [PAD + (x - main.x0) * s, PAD + (main.y1 - y) * s];
}
const r1 = (n) => Math.round(n * 10) / 10;

function pathD(geometry, tf) {
  let d = "";
  for (const ring of rings(geometry)) {
    const pts = ring.map(tf).map(([x, y]) => [r1(x), r1(y)]);
    // 連続する同一点を詰める
    const uniq = pts.filter((p, i) => i === 0 || p[0] !== pts[i - 1][0] || p[1] !== pts[i - 1][1]);
    if (uniq.length < 3) continue;
    d += "M" + uniq.map(([x, y]) => `${x} ${y}`).join("L") + "Z";
  }
  return d;
}

const prefs = {};
for (const f of shapes) {
  const code = f.properties.code;
  const tf = transformFor(code);
  const pt = points.find((p) => p.properties.code === code);
  const [px, py] = tf(pt.geometry.coordinates);
  prefs[code] = { d: pathD(f.geometry, tf), px: r1(px), py: r1(py) };
}

const codes = Object.keys(prefs).sort();
if (codes.length !== 47) throw new Error(`expected 47 prefectures, got ${codes.length}`);

const out = {
  source: "Natural Earth 1:10m Admin 1 – States, Provinces (public domain)",
  viewBox: [0, 0, width, height],
  inset,
  prefs: Object.fromEntries(codes.map((c) => [c, prefs[c]])),
};
writeFileSync(OUT, JSON.stringify(out) + "\n");
console.log(`wrote ${OUT} (${(JSON.stringify(out).length / 1024).toFixed(1)} KB, viewBox ${width}x${height})`);
