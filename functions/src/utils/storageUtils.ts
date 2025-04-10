import * as admin from 'firebase-admin';

/**
 * Cloud Storageにファイルを保存する
 * @param path 保存先のパス
 * @param content ファイルの内容
 * @param options オプション（contentType, metadata等）
 * @returns ファイルのURLと保存結果
 */
export const saveToStorage = async (
	path: string,
	content: string | Buffer,
	options: {
		contentType?: string;
		metadata?: Record<string, string>;
	} = {}
): Promise<{ url: string; fileRef: any }> => {
	const bucket = admin.storage().bucket();
	const file = bucket.file(path);

	// デフォルトオプション
	const saveOptions = {
		contentType: options.contentType || 'application/octet-stream',
		metadata: options.metadata || {}
	};

	// ファイルを保存
	await file.save(content, saveOptions);

	// ファイルのURLを取得（署名付きURL）
	const [url] = await file.getSignedUrl({
		action: 'read',
		expires: '03-01-2500' // 長期間有効なURL
	});

	return { url, fileRef: file };
};

/**
 * Cloud Storageからファイルを読み込む
 * @param path ファイルパス
 * @returns ファイルの内容
 */
export const readFromStorage = async (path: string): Promise<Buffer> => {
	const bucket = admin.storage().bucket();
	const file = bucket.file(path);

	const [content] = await file.download();
	return content;
};

/**
 * Cloud Storage内のファイルが存在するか確認
 * @param path ファイルパス
 * @returns 存在する場合はtrue
 */
export const fileExists = async (path: string): Promise<boolean> => {
	const bucket = admin.storage().bucket();
	const file = bucket.file(path);

	const [exists] = await file.exists();
	return exists;
};