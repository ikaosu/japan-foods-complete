# 🗾 47都道府県 料理制覇マップ

**47都道府県の郷土料理を、ぜんぶ食べる**企画の記録サイト。
「世界料理制覇マップ」の姉妹サイトです。

- その県の郷土料理・ご当地グルメを食べたら、その県は「制覇」（食べた場所は問わない）
- 投稿時に「📍 現地で食べた」を付けると、地図にマーカーが立ち、一覧でも区別される
- 日本地図（沖縄は左上の別枠）が食べた県から色づく。投稿数に応じて4段階で濃くなる
- 地方別（北海道・東北・関東・中部・近畿・中国・四国・九州沖縄）の制覇状況
- 写真 + コメントのフィード、県別モーダル、47都道府県の一覧・検索
- サーバー・DB 不要 / 完全無料（GitHub Pages）。投稿はサイトから直接 GitHub にコミット

---

## 仕組み

```
スマホでサイトを開く（管理者モードの端末だけ「＋投稿」が出る）
   └─ 写真・都道府県・料理名・コメント・現地チェックを入力して「投稿する」
        │  ブラウザ内で写真を縮小（長辺1600px JPEG、HEIC も自動変換）
        ▼  GitHub Contents API（トークンはその端末のブラウザにのみ保存）
   images/ に写真、data/posts.json に投稿を commit
        │
        ▼
   GitHub Pages が自動で再公開（1〜2分）→ 地図の県が色づく
```

投稿直後は画面に即時反映し、公開版に反映されるまでの間に再読み込みしても消えません（反映待ちの控えをブラウザに保持）。

---

## セットアップ

### 1. リポジトリを作って公開

このフォルダの中身を、新しいリポジトリのルートに置いて push します。

```bash
# GitHub で空のリポジトリを作成しておく（例: japan-foods-complete）
cd japan-food-map
git init
git add .
git commit -m "init: 47都道府県 料理制覇マップ"
git branch -M main
git remote add origin https://github.com/<あなた>/japan-foods-complete.git
git push -u origin main
```

### 2. GitHub Pages を有効化

リポジトリの **Settings → Pages** で:

- **Source**: `Deploy from a branch`
- **Branch**: `main` / `/ (root)` → Save

数十秒後、`https://<あなた>.github.io/<リポジトリ名>/` で公開されます。

### 3. 投稿できるようにする（管理者モード）

投稿UIは通常は非表示で、**一般の閲覧者には「＋投稿」ボタンも GitHub 設定も見えません**。
自分の端末で、**一度だけ URL の末尾に `#admin` を付けて開きます**:

```
https://<あなた>.github.io/<リポジトリ名>/#admin
```

これでその端末が管理者モードになり、右下に **「＋ 投稿」** が出ます。以後は普通に開くだけでOK。

初回だけ GitHub のアクセストークンが必要です:

1. GitHub → Settings → Developer settings → **Fine-grained tokens** → Generate new token
   - **Repository access**: このリポジトリのみ
   - **Permissions → Repository permissions → Contents** を **Read and write** に
2. サイトの「＋ 投稿」→ **⚙ 設定** にトークンを入力して保存
   （`github.io` で開いていれば、ユーザー名・リポジトリ名は自動入力）

> - トークンはコードに埋め込まれず、その端末のブラウザにのみ保存されます。共用PCでは保存しないでください。
> - 世界版と同じブラウザで使っても、管理者モード・トークン・表示設定は別々に保存されます（保存キーが `jfm-*`）。トークンは**このリポジトリ用**に別途作ってください。

---

## 投稿のしかた

「＋ 投稿」を押して入力するだけ:

| 項目 | 必須 | 例 |
|---|---|---|
| 写真 | ○（新規投稿時） | 選んだ瞬間から裏で縮小・変換を始めるので、投稿時の待ちはほぼゼロ |
| 都道府県 | ○ | `青森` `青森県` `あおもり` `Aomori` `2`（JIS コード）など表記ゆれOK。認識結果が下に出る |
| 料理名 | | `せんべい汁` |
| コメント | | 改行もそのまま表示 |
| 📍 現地で食べた | | その都道府県内で食べたらチェック |

**編集・削除**: 管理者モードでは、県のモーダルに各投稿の「編集／削除」ボタンが出ます。
**管理者モードの解除**: 「＋投稿 → ⚙設定 →『この端末の管理者モードを解除』」（保存トークンも消えます）。

### ホーム画面に追加（PWA）

- **iPhone (Safari)**: 共有ボタン →「ホーム画面に追加」
- **Android (Chrome)**: メニュー（︙）→「アプリをインストール」/「ホーム画面に追加」

アイコンから全画面で起動し、オフラインでも最後に見た内容が開きます。

---

## カスタマイズ

| やりたいこと | 場所 |
|---|---|
| 配色・見た目 | `assets/styles.css`（CSS変数 `--brand`、塗りの段階 `--lv1`〜`--lv4`、現地マーカー `--pin`） |
| 塗りの段階のしきい値（1 / 2 / 3〜4 / 5品以上） | `assets/app.js` の `levelFor()` |
| 地方区分・県名・読み・ローマ字 | `data/prefectures.json` |
| 地図の形（島の取捨・簡略化・沖縄枠の大きさ） | `tools/build-map.mjs` を編集して再生成（下記） |

### 地図データの作り直し

サイトの実行には不要です。地図の形を変えたいときだけ:

```bash
curl -L -o ne_admin1.geojson \
  https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_admin_1_states_provinces.geojson
npm i --no-save mapshaper
node tools/build-map.mjs ne_admin1.geojson   # → data/japan-map.json
```

面積25km²未満の島と、奄美・小笠原・大東などの遠方の島は省いています（地図の見やすさ優先）。

---

## ローカルで確認

相対パスで `fetch` するので、ファイルを直接開くのではなく簡易サーバー経由で:

```bash
npm run serve        # または: python -m http.server 8000
```

---

## データ形式（`data/posts.json`）

```json
{
  "id": "web-1790864282200-330",
  "code": "02",
  "pref": "青森県",
  "dish": "せんべい汁",
  "comment": "八戸の朝市で。",
  "local": true,
  "image": "images/web-1790864282200-330-1790864282200.jpg",
  "date": "2026-10-01T14:18:02.212Z",
  "source": "web",
  "rev": 1790864282212
}
```

`code` は JIS 都道府県コード（`01` 北海道 〜 `47` 沖縄県）。`local` が無い投稿は「現地ではない」として扱います。

## ファイル構成

```
index.html               サイト本体
assets/styles.css        スタイル
assets/app.js            地図描画・統計・一覧・検索・モーダル
assets/post.js           管理者モードの投稿・編集・削除（GitHub API）
data/prefectures.json    地方区分 + 47都道府県の辞書（名称・読み・ローマ字）
data/japan-map.json      日本地図の SVG パス（tools/build-map.mjs で生成）
data/posts.json          投稿データ（サイトからの投稿で更新）
images/                  投稿写真
icons/ manifest.webmanifest sw.js   PWA 用
tools/build-map.mjs      地図データ生成スクリプト
```

## データ出典・ライセンス

- 日本地図: [Natural Earth](https://www.naturalearthdata.com/) 1:10m Admin 1 – States, Provinces（パブリックドメイン）を加工して生成
- HEIC 変換: [heic2any](https://github.com/alexcorvi/heic2any)（MIT、CDN から読み込み）
