const fs = require('fs');
const crypto = require('crypto');

// コマンドライン引数からJSONファイルのパスを取得
const jsonFilePath = process.argv[2];

if (!jsonFilePath) {
  console.error('使用方法: node verifyHash.js <JSONファイルのパス> [期待されるハッシュ値]');
  process.exit(1);
}

// JSONファイルを読み込む
const jsonData = JSON.parse(fs.readFileSync(jsonFilePath, 'utf8'));

// JSON文字列化（空白なし）
const jsonString = JSON.stringify(jsonData);

// SHA-256ハッシュを計算
const calculatedHash = crypto.createHash('sha256').update(jsonString).digest('hex');

// 期待されるハッシュ値（コマンドライン引数から取得または既知の値を使用）
const expectedHash = process.argv[3] || "b66055cb24dd8fa1cc3adfc9764bfc6e66818fa2fec9557721c4477200d493b1";

console.log('JSON内容:');
console.log(jsonString);
console.log('期待されるハッシュ:',expectedHash);
const formattedJsonString = JSON.stringify(jsonData, null, 2);
const formattedHash = crypto.createHash('sha256').update(formattedJsonString).digest('hex');
console.log('整形JSON用ハッシュ:', formattedHash);
console.log('一致しているか:', formattedHash === expectedHash);
