import * as crypto from 'crypto';

/**
 * 文字列またはオブジェクトのSHA256ハッシュを計算する
 * @param data ハッシュ化するデータ（文字列またはオブジェクト）
 * @returns SHA256ハッシュ文字列（16進数）
 */
export const calculateSHA256 = (data: string | object): string => {
  // オブジェクトの場合は文字列に変換
  const content = typeof data === 'object' ? JSON.stringify(data) : data;
  
  // SHA256ハッシュを計算して16進数で返す
  return crypto.createHash('sha256').update(content).digest('hex');
};

/**
 * データの整合性を検証する
 * @param data 検証するデータ
 * @param hash 期待されるハッシュ値
 * @returns 検証結果（true: 整合性あり、false: 整合性なし）
 */
export const verifyIntegrity = (data: string | object, hash: string): boolean => {
  const calculatedHash = calculateSHA256(data);
  return calculatedHash === hash;
};

/**
 * ランダムなIDを生成する
 * @param prefix IDのプレフィックス
 * @param length ランダム部分の長さ
 * @returns 生成されたID
 */
export const generateUniqueId = (prefix: string, length: number = 8): string => {
  const randomPart = Math.random().toString(36).substring(2, 2 + length);
  const timestamp = Date.now().toString(36);
  return `${prefix}_${timestamp}_${randomPart}`;
};


/**
 * ブロックチェーンのトランザクションデータをデコードする
 * @param hexData 16進数形式のトランザクションデータ (0xプレフィックスあり/なし両方対応)
 * @returns デコードされたJSONオブジェクト
 */
export const decodeTransactionData = (hexData: string): any => {
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
  };
  
  /**
   * トランザクションデータの検証
   * @param hexData 16進数形式のトランザクションデータ
   * @param expectedHash 期待されるハッシュ値
   * @returns 検証結果
   */
  export const verifyTransactionData = (hexData: string, expectedHash: string): boolean => {
	const decoded = decodeTransactionData(hexData);
	return decoded && decoded.hash === expectedHash;
  };