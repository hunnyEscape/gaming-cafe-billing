import * as admin from 'firebase-admin';

// Firestoreデータベース参照を取得
export const db = admin.firestore();

// コレクション参照を取得する汎用関数
export const getCollection = (collectionName: string) => {
	return db.collection(collectionName);
};

// ドキュメントIDで特定のドキュメントを取得
export const getDocumentById = async <T>(
	collectionName: string,
	documentId: string
): Promise<T | null> => {
	const docRef = db.collection(collectionName).doc(documentId);
	const doc = await docRef.get();

	if (!doc.exists) {
		return null;
	}

	return { ...doc.data(), id: doc.id } as T;
};

// 単一条件でのクエリを実行
export const queryByField = async <T>(
	collectionName: string,
	fieldName: string,
	operator: FirebaseFirestore.WhereFilterOp,
	value: any
): Promise<T[]> => {
	const snapshot = await db.collection(collectionName)
		.where(fieldName, operator, value)
		.get();

	return snapshot.docs.map(doc => ({ ...doc.data(), id: doc.id } as T));
};