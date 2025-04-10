// verifyTransaction.js - スタンドアロンのトランザクションデコードスクリプト

/**
 * 16進数形式のトランザクションデータをデコードする
 * @param hexData 16進数形式のデータ
 * @returns デコードされたJSONオブジェクト
 */
function decodeTransactionData(hexData) {
	// 0xプレフィックスがあれば削除
	const cleanHex = hexData.startsWith('0x') ? hexData.substring(2) : hexData;

	// 16進数をUTF-8文字列に変換
	let decodedString = '';
	for (let i = 0; i < cleanHex.length; i += 2) {
		decodedString += String.fromCharCode(parseInt(cleanHex.substr(i, 2), 16));
	}

	// JSONとしてパース
	try {
		return JSON.parse(decodedString);
	} catch (error) {
		console.error('JSON解析エラー:', error);
		return { error: 'JSONとして解析できませんでした', rawData: decodedString };
	}
}

// テスト用の16進数データ (コマンドライン引数から取得、なければサンプルを使用)
const hexData = process.argv[2] || "7b2268617368223a2262363630353563623234646438666131636333616466633937363462666336653636383138666132666563393535373732316334343737323030643439336231222c226d65746164617461223a7b2262696c6c696e674964223a2262696c6c5f313734343030383131343535375f6e386463636e64222c2274797065223a2267616d696e675f636166655f62696c6c696e67222c2274696d657374616d70223a313734343030383131383038342c2270726f6a6563744964223a22652d73706f7274732d73616b7572612d6236613136227d7d";

// デコードして結果を表示
const decoded = decodeTransactionData(hexData);
console.log('デコード結果:');
console.log(JSON.stringify(decoded, null, 2));

// ハッシュ値を抽出
if (decoded && decoded.hash) {
	console.log('\nハッシュ値:');
	console.log(decoded.hash);
}

// メタデータを抽出
if (decoded && decoded.metadata) {
	console.log('\nメタデータ:');
	console.log(JSON.stringify(decoded.metadata, null, 2));
}