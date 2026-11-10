// 公開してよい設定だけを書く（トークンは合言葉で暗号化したものだけ）
export default {
  owner: 'daikikaneko1',
  repo: 'kaneko-roumu-data',
  path: 'data/roumu.json',
  branch: 'main',
  encToken: null, // tools/encrypt-token.mjs または setup.html で作った暗号文をここに入れる
};
