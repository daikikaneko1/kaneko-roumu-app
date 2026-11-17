// パトロール履歴：公開してよい設定だけ（トークンはパトロール用の合言葉で暗号化したものだけ）
export default {
  owner: 'daikikaneko1',
  repo: 'kaneko-roumu-data',
  branch: 'main',
  dir: 'data/patrol',
  roumuPath: 'data/roumu.json', // 現場の一覧（読むだけ）
  encToken: {"v":1,"kdf":"PBKDF2-SHA256","iter":600000,"salt":"vIXMWnt9ki/FoTzmaob99w==","iv":"so2tQ89FP/1EVqy4","ct":"bAUCCUrWg8L6/EanCi/6jyvUcbvvbwLopowBAP5IrYbQLfVMeFioIlkYfmLGGqF1IbQq1xORxnlozRpLJvJ0V+86SL6NI6sIPTrfRhPA4RdfnmCVoN/89b2CwYdiqq/uWxMbhV8NgH+RgTJocQ=="},
};
