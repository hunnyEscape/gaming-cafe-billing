
### FILE: ./functions/src/services/billing/generateBillingJSON.ts
import * as functions from 'firebase-functions/v1';
import * as admin from 'firebase-admin';
import * as crypto from 'crypto';
import { COLLECTIONS } from '../../config/constants';
import { SessionDocument, UserDocument } from '../../types';

/**
 * 課金データJSON生成関数
 * 課金キューのデータを基に課金JSONを生成し、Cloud Storageに保存します
 */
export const generateBillingJSON = functions.firestore
	.document(`${COLLECTIONS.BILLING_QUEUE}/{docId}`)
	.onCreate(async (snapshot, context) => {
		try {
			const billingRequest = snapshot.data();
			const { sessionId, userId, seatId } = billingRequest;

			functions.logger.info(`課金データ生成開始: SessionID=${sessionId}, UserID=${userId}, SeatID=${seatId}`);

			// Firestoreデータベース参
			const db = admin.firestore();

			// セッション詳細を取得
			const sessionDoc = await db.collection(COLLECTIONS.SESSIONS).doc(sessionId).get();

			if (!sessionDoc.exists) {
				throw new Error('セッションが見つかりません');
			}

			const sessionData = sessionDoc.data() as SessionDocument;

			// セッションが正常に終了しているか確認
			if (sessionData.active || !sessionData.endTime) {
				throw new Error('セッションがまだ終了していません');
			}

			// ユーザー情報を取得（オプション）
			const userDoc = await db.collection(COLLECTIONS.USERS).doc(userId).get();
			const userData = userDoc.exists ? userDoc.data() as UserDocument : null;
			const membershipType = userData?.stripe?.paymentStatus === 'active' ? 'premium' : 'standard';

			// 課金データの生成
			const billingId = `bill_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
			
			// 日時の変換
			const startTimeStr = sessionData.startTime instanceof admin.firestore.Timestamp 
				? sessionData.startTime.toDate().toISOString() 
				: sessionData.startTime.toString();
				
			const endTimeStr = sessionData.endTime instanceof admin.firestore.Timestamp 
				? sessionData.endTime.toDate().toISOString() 
				: sessionData.endTime.toString();

			// 課金JSONデータ構造
			const billingJson = {
				billingId,
				userId,
				sessionId,
				seatId,
				startTime: startTimeStr,
				endTime: endTimeStr,
				duration: sessionData.duration,
				timestamp: Date.now(),
				memberType: membershipType
			};

			// JSONを文字列に変換
			const jsonString = JSON.stringify(billingJson, null, 2);

			// ファイル名の生成
			const date = new Date();
			const yearMonth = `${date.getFullYear()}${(date.getMonth() + 1).toString().padStart(2, '0')}`;
			const timestamp = Date.now();
			const randomStr = Math.random().toString(36).substring(2, 8);
			const fileName = `billing_${yearMonth}_${userId}_${seatId}_${timestamp}_${randomStr}.json`;
			const storagePath = `userBillings/${fileName}`;

			// Cloud Storageに保存
			const bucket = admin.storage().bucket();
			const file = bucket.file(storagePath);

			await file.save(jsonString, {
				contentType: 'application/json',
				metadata: {
					userId,
					sessionId,
					billingId
				}
			});

			// SHA256ハッシュ計算
			const hashValue = crypto.createHash('sha256').update(jsonString).digest('hex');

			// billingProofsに保存するデータを準備
			const proofData = {
				billingId,
				userId,
				sessionId,
				seatId,
				fileUrl: storagePath,
				hash: hashValue,
				chainId: '43114', // Avalanche C-Chain
				networkId: 1,
				txId: null,
				blockNumber: null,
				status: 'pending',
				createdAt: admin.firestore.Timestamp.now(),
				confirmedAt: null
			};

			// billingProofsコレクションに保存
			await db.collection(COLLECTIONS.BILLING_PROOFS).doc(billingId).set(proofData);

			// セッションのbillingId参照のある場合は更新（新インターフェースではなくなったがバックワードコンパチビリティのため）
			try {
				await db.collection(COLLECTIONS.SESSIONS).doc(sessionId).update({
					billingId
				});
			} catch (e) {
				functions.logger.warn(`SessionDocument does not have billingId field, skipping update.`);
			}

			// 課金キューの状態を更新
			await snapshot.ref.update({
				status: 'processed',
				billingId,
				hashValue,
				updatedAt: admin.firestore.Timestamp.now()
			});

			functions.logger.info(`課金データ生成完了: BillingID=${billingId}, Hash=${hashValue}`);

			return { success: true, billingId, hashValue };
		} catch (error) {
			functions.logger.error('課金データ生成エラー:', error instanceof Error ? error.message : String(error));

			// エラー情報を課金キューに記録
			await snapshot.ref.update({
				status: 'error',
				errorMessage: error instanceof Error ? error.message : String(error),
				updatedAt: admin.firestore.Timestamp.now()
			});

			throw error;
		}
	});
### FILE: ./functions/src/services/billing/saveHashToBlockchain.ts
import * as functions from 'firebase-functions/v1';
import * as admin from 'firebase-admin';
import { ethers } from 'ethers';
import { COLLECTIONS, CHAIN_CONFIG } from '../../config/constants';
import { BillingProof } from '../../types';

/**
 * ブロックチェーンへのハッシュ保存関数
 * 課金証明データのハッシュ値をAvalanche C-Chainに記録します
 */
export const saveHashToBlockchain = functions.firestore
	.document(`${COLLECTIONS.BILLING_PROOFS}/{billingId}`)
	.onCreate(async (snapshot, context) => {
		const newValue = snapshot.data() as BillingProof;

		// 処理条件チェック（hash存在確認とステータス確認）
		if (!newValue.hash || newValue.status !== 'pending' || newValue.txId) {
			functions.logger.info(`処理をスキップ: BillingID=${context.params.billingId}, Status=${newValue.status}`);
			return null;
		}

		const billingId = context.params.billingId;

		try {
			functions.logger.info(`ブロックチェーン保存開始: BillingID=${billingId}, Hash=${newValue.hash}`);

			// プライベートキーを環境変数から取得
			const privateKey = functions.config().avalanche?.privatekey;

			if (!privateKey) {
				throw new Error('Avalancheプライベートキーが設定されていません。FIREBASE_CONFIG.avalanche.privatekeyを設定してください。');
			}

			// Avalanche C-Chain RPCプロバイダーの設定
			const provider = new ethers.providers.JsonRpcProvider(CHAIN_CONFIG.RPC_ENDPOINT);

			// ウォレットの初期化
			const wallet = new ethers.Wallet(privateKey, provider);

			// メタデータの準備
			const metadata = {
				billingId,
				type: 'gaming_cafe_billing',
				timestamp: Date.now(),
				projectId: process.env.GCLOUD_PROJECT || 'e-sports-sakura-b6a16'
			};

			// JSON形式のハッシュデータとメタデータ
			const dataToSend = JSON.stringify({
				hash: newValue.hash,
				metadata
			});

			functions.logger.info(`トランザクション送信準備: アドレス=${wallet.address}, データ長=${dataToSend.length}バイト`);

			// トランザクションの作成と送信
			// 自分自身に0 AVAXを送信し、データとしてハッシュを埋め込む
			const tx = await wallet.sendTransaction({
				to: wallet.address, // 自分自身に送信
				value: ethers.utils.parseEther('0'), // 0 AVAX
				data: ethers.utils.hexlify(ethers.utils.toUtf8Bytes(dataToSend)),
				gasLimit: 100000
			});

			functions.logger.info(`トランザクション送信完了: TxHash=${tx.hash}`);

			// トランザクションの完了を待機
			const receipt = await tx.wait(1); // 1ブロックの確認を待つ

			functions.logger.info(`トランザクション確認完了: Block=${receipt.blockNumber}, GasUsed=${receipt.gasUsed.toString()}`);

			// Firestoreのデータを更新
			const db = admin.firestore();
			await db.collection(COLLECTIONS.BILLING_PROOFS).doc(billingId).update({
				txId: receipt.transactionHash,
				blockNumber: receipt.blockNumber,
				status: 'confirmed',
				confirmedAt: admin.firestore.Timestamp.now()
			});

			functions.logger.info(`ブロックチェーン保存完了: BillingID=${billingId}, TxID=${receipt.transactionHash}, Block=${receipt.blockNumber}`);

			return {
				success: true,
				txId: receipt.transactionHash,
				blockNumber: receipt.blockNumber
			};
		} catch (error) {
			functions.logger.error('ブロックチェーン保存エラー:', error instanceof Error ? error.message : String(error));

			// エラー情報をFirestoreに記録
			const db = admin.firestore();
			await db.collection(COLLECTIONS.BILLING_PROOFS).doc(billingId).update({
				status: 'error',
				errorMessage: error instanceof Error ? error.message : String(error),
				updatedAt: admin.firestore.Timestamp.now()
			});

			throw error;
		}
	});
### FILE: ./functions/src/services/billing/saveSessionJson.ts
import * as functions from 'firebase-functions/v1';
import * as admin from 'firebase-admin';
import * as crypto from 'crypto';
import { COLLECTIONS } from '../../config/constants';
import { SessionDocument, UserDocument } from '../../types';

export const saveSessionJson = functions.firestore
	.document(`${COLLECTIONS.BILLING_QUEUE}/{docId}`)
	.onCreate(async (snapshot, context) => {
		try {
			const { sessionId, userId, seatId } = snapshot.data() as {
				sessionId: string;
				userId: string;
				seatId: string;
			};

			functions.logger.info(
				`セッションデータJSON生成開始: SessionID=${sessionId}, UserID=${userId}, SeatID=${seatId}`
			);

			const db = admin.firestore();

			// セッション詳細を取得
			const sessionDoc = await db.collection(COLLECTIONS.SESSIONS).doc(sessionId).get();
			if (!sessionDoc.exists) throw new Error('セッションが見つかりません');
			const sessionData = sessionDoc.data() as SessionDocument;

			// 終了チェック
			if (sessionData.active || !sessionData.endTime) {
				throw new Error('セッションがまだ終了していません');
			}

			// ユーザー情報取得（オプション）
			const userDoc = await db.collection(COLLECTIONS.USERS).doc(userId).get();
			const userData = userDoc.exists ? (userDoc.data() as UserDocument) : null;
			const membershipType =
				userData?.stripe?.paymentStatus === 'active' ? 'premium' : 'standard';

			// JSON 構造の生成
			const billingJson = {
				sessionId,
				userId,
				seatId,
				startTime:
					sessionData.startTime instanceof admin.firestore.Timestamp
						? sessionData.startTime.toDate().toISOString()
						: sessionData.startTime,
				endTime:
					sessionData.endTime instanceof admin.firestore.Timestamp
						? sessionData.endTime.toDate().toISOString()
						: sessionData.endTime,
				duration: sessionData.duration,          // ← 新フィールド
				hourBlocks: sessionData.hourBlocks ?? 0, // ← 新フィールド
				memberType: membershipType,
				timestamp: Date.now()
			};

			const jsonString = JSON.stringify(billingJson, null, 2);

			// ファイル名・パスを JST で生成
			const now = new Date();
			const jstString = now
				.toLocaleString('ja-JP', {
					timeZone: 'Asia/Tokyo',
					year: 'numeric',
					month: '2-digit',
					day: '2-digit',
					hour: '2-digit',
					minute: '2-digit',
					second: '2-digit',
					hour12: false
				})
				.replace(/[\/\s:]/g, '');

			const fileName = `${jstString}_${sessionId}.json`;
			const storagePath = `sessionLog/${userId}/${fileName}`;

			// Cloud Storage に保存
			const bucket = admin.storage().bucket();
			await bucket.file(storagePath).save(jsonString, {
				contentType: 'application/json',
				metadata: { userId, sessionId }
			});

			// SHA256 ハッシュ
			const hashValue = crypto.createHash('sha256').update(jsonString).digest('hex');

			// Proofs コレクションに保存
			const proofData = {
				sessionId,
				userId,
				seatId,
				fileUrl: storagePath,
				hash: hashValue,
				status: 'pending',
				createdAt: admin.firestore.Timestamp.now()
			};
			await db.collection(COLLECTIONS.BILLING_PROOFS).doc(sessionId).set(proofData);

			// キューの状態更新
			await snapshot.ref.update({
				status: 'processed',
				hashValue,
				updatedAt: admin.firestore.Timestamp.now()
			});

			functions.logger.info(`JSON生成完了: SessionID=${sessionId}, Hash=${hashValue}`);
			return { success: true, hashValue };
		} catch (error) {
			functions.logger.error('JSON生成エラー:', error instanceof Error ? error.message : String(error));
			await snapshot.ref.update({
				status: 'error',
				errorMessage: error instanceof Error ? error.message : String(error),
				updatedAt: admin.firestore.Timestamp.now()
			});
			throw error;
		}
	});

### FILE: ./functions/src/services/sessions/endSessionHttp.ts
import * as functions from 'firebase-functions';
import * as admin from 'firebase-admin';
import { COLLECTIONS, SEAT_STATUS } from '../../config/constants';
import { SessionDocument } from '../../types';

/**
 * セッション終了HTTP関数
 */
export const endSessionHttp = functions.https.onRequest(async (req, res) => {
	// CORSヘッダー設定
	res.set('Access-Control-Allow-Origin', '*');
	res.set('Access-Control-Allow-Methods', 'GET, POST');
	res.set('Access-Control-Allow-Headers', 'Content-Type');

	// OPTIONS（プリフライト）
	if (req.method === 'OPTIONS') {
		res.status(204).send('');
		return;
	}
	if (req.method !== 'POST') {
		res.status(405).json({ success: false, error: 'Please use POST.' });
		return;
	}

	try {
		const { sessionId, seatId } = req.body;
		if (!sessionId && !seatId) {
			res.status(400).json({ success: false, error: 'sessionId or seatId is required.' });
			return;
		}

		const db = admin.firestore();
		let ref = sessionId
			? db.collection(COLLECTIONS.SESSIONS).doc(sessionId)
			: (await db
				.collection(COLLECTIONS.SESSIONS)
				.where('seatId', '==', seatId)
				.where('active', '==', true)
				.limit(1)
				.get()).docs[0].ref;

		const snap = await ref.get();
		if (!snap.exists) {
			res.status(404).json({ success: false, error: 'Session not found.' });
			return;
		}
		const data = snap.data() as SessionDocument;
		if (!data.active) {
			res.status(409).json({ success: false, error: 'Session already ended.' });
			return;
		}

		const result = await db.runTransaction(async tx => {
			// JST補正済 Timestamp
			const now = new Date();
			const jstDate = new Date(now.getTime() + 9 * 60 * 60 * 1000);
			const endTime = admin.firestore.Timestamp.fromDate(jstDate);

			const startMs = (data.startTime as admin.firestore.Timestamp).toMillis();
			const duration = Math.ceil((endTime.toMillis() - startMs) / 1000);  // 秒単位
			const hourBlocks = Math.ceil(duration / 3600);  

			tx.update(ref, { endTime, duration, hourBlocks, active: false });
			tx.update(db.collection(COLLECTIONS.SEATS).doc(data.seatId), {
				status: SEAT_STATUS.AVAILABLE,
				updatedAt: admin.firestore.Timestamp.now()
			});
			tx.set(db.collection(COLLECTIONS.BILLING_QUEUE).doc(), {
				sessionId: data.sessionId,
				userId: data.userId,
				seatId: data.seatId,
				status: 'pending',
				createdAt: admin.firestore.Timestamp.now()
			});

			return { sessionId: data.sessionId, userId: data.userId, seatId: data.seatId, startTime: data.startTime, endTime, duration, hourBlocks };
		});

		res.status(200).json({ success: true, message: 'Session ended.', session: result });
	} catch (e) {
		functions.logger.error('endSessionHttp error:', e);
		res.status(500).json({ success: false, error: (e as Error).message });
	}
});

### FILE: ./functions/src/services/sessions/startSessionHttp.ts
import * as functions from 'firebase-functions';
import * as admin from 'firebase-admin';
import { COLLECTIONS, SEAT_STATUS } from '../../config/constants';
import { SessionDocument, SeatDocument } from '../../types';

/**
 * セッション開始HTTP関数
 */
export const startSessionHttp = functions.https.onRequest(async (req, res) => {
	// CORSヘッダー設定
	res.set('Access-Control-Allow-Origin', '*');
	res.set('Access-Control-Allow-Methods', 'GET, POST');
	res.set('Access-Control-Allow-Headers', 'Content-Type');

	// OPTIONS（プリフライト）
	if (req.method === 'OPTIONS') {
		res.status(204).send('');
		return;
	}
	if (req.method !== 'POST') {
		res.status(405).json({ success: false, error: 'Please use POST.' });
		return;
	}

	try {
		const { userId, seatId } = req.body;
		if (!userId || !seatId) {
			res.status(400).json({ success: false, error: 'userId and seatId are required.' });
			return;
		}

		const db = admin.firestore();
		const userDoc = await db.collection(COLLECTIONS.USERS).doc(userId).get();
		if (!userDoc.exists) {
			res.status(404).json({ success: false, error: 'User not found.' });
			return;
		}

		const seatRef = db.collection(COLLECTIONS.SEATS).doc(seatId);
		const seatDoc = await seatRef.get();
		if (!seatDoc.exists) {
			res.status(404).json({ success: false, error: 'Seat not found.' });
			return;
		}
		const seatData = seatDoc.data() as SeatDocument;
		if (seatData.status !== SEAT_STATUS.AVAILABLE) {
			res.status(409).json({ success: false, error: `Seat not available. Status: ${seatData.status}` });
			return;
		}

		const activeQuery = await db
			.collection(COLLECTIONS.SESSIONS)
			.where('seatId', '==', seatId)
			.where('active', '==', true)
			.limit(1)
			.get();
		if (!activeQuery.empty) {
			res.status(409).json({ success: false, error: 'An active session already exists.' });
			return;
		}

		const result = await db.runTransaction(async tx => {
			const sessionId = `sess_${Date.now()}_${Math.random().toString(36).slice(2)}`;
			// JST補正済 Timestamp を作成
			const now = new Date();
			const jstDate = new Date(now.getTime() + 9 * 60 * 60 * 1000);
			const startTime = admin.firestore.Timestamp.fromDate(jstDate);

			const sessionData: SessionDocument = {
				sessionId,
				userId,
				seatId,
				startTime,
				endTime: '',
				pricePerHour: seatData.ratePerHour || 600,
				active: true,
				duration: 0
			};

			const sessionRef = db.collection(COLLECTIONS.SESSIONS).doc(sessionId);
			tx.set(sessionRef, sessionData);
			tx.update(seatRef, { status: SEAT_STATUS.IN_USE, updatedAt: admin.firestore.Timestamp.now() });

			return { sessionId, userId, seatId, startTime };
		});

		res.status(200).json({ success: true, message: 'Session started.', session: result });
	} catch (e) {
		functions.logger.error('startSessionHttp error:', e);
		res.status(500).json({ success: false, error: (e as Error).message });
	}
});

### FILE: ./functions/src/types/index.ts
import { Timestamp } from 'firebase-admin/firestore';

export interface UserDocument {
	uid: string;
	email: string | null;
	displayName: string | null;
	photoURL: string | null;
	createdAt: Timestamp | string;
	lastLogin: Timestamp | string;
	registrationCompleted: boolean;
	registrationCompletedAt?: string;
	registrationStep?: number;
	// Stripe情報
	stripe?: {
		customerId?: string;
		paymentMethodId?: string;
		paymentSetupCompleted?: boolean;
		createdAt?: string;
		updatedAt?: string;
		paymentMethodType?: string;
		paymentMethodBrand?: string;
		paymentMethodLast4?: string;
		paymentStatus?: string;
		lastPaymentError?: string;
		lastPaymentErrorAt?: string;
	};
}

export interface SeatDocument {
	seatId: string;
	branchCode: string;
	branchName: string;
	seatType: string;
	seatNumber: number;
	name: string;
	ipAddress?: string;
	ratePerHour: number;
	status: 'available' | 'in-use' | 'maintenance';
	hourBlocks?: number;
	availableHours?: {
		[key: string]: string;
	};
	maxAdvanceBookingDays?: number;
	createdAt: Timestamp | string;
	updatedAt: Timestamp | string;
}


export interface SessionDocument {
	sessionId: string;
	userId: string;
	seatId: string;
	// JSTで記録されたFirestore Timestamp（UTC+9補正済）
	startTime: Timestamp | string;
	endTime: Timestamp | string;
	pricePerHour: number;
	active: boolean;
	duration: number;
	hourBlocks?: number;
}

export interface BillingProof {
  billingId: string;
  userId: string;
  sessionId: string;
  seatId: string;
  fileUrl: string;
  hash: string;
  chainId: string;
  networkId: number;
  txId: string | null;
  blockNumber: number | null;
  status: string;
  createdAt: Timestamp;
  confirmedAt: Timestamp | null;
}

export interface BillingQueueItem {
  sessionId: string;
  userId: string;
  seatId: string;
  status: string;
  createdAt: Timestamp;
  billingId?: string;
  hashValue?: string;
  updatedAt?: Timestamp;
  errorMessage?: string;
}
### FILE: ./functions/src/config/constants.ts
export const COLLECTIONS = {
	USERS: 'users',
	SEATS: 'seats',
	SESSIONS: 'sessions',
	BILLING_PROOFS: 'billingProofs',
	BILLING_QUEUE: 'billingQueue'
  };
  
  export const SESSION_STATUS = {
	ACTIVE: 'active',
	COMPLETED: 'completed',
	ERROR: 'error'
  };
  
  export const SEAT_STATUS = {
	AVAILABLE: 'available',
	IN_USE: 'in-use',
	MAINTENANCE: 'maintenance'
  };
  
  export const BILLING_STATUS = {
	PENDING: 'pending',
	PROCESSING: 'processing',
	CONFIRMED: 'confirmed',
	ERROR: 'error'
  };
  
  export const CHAIN_CONFIG = {
	CHAIN_ID: '43114',
	NETWORK_ID: 1,
	RPC_ENDPOINT: 'https://api.avax.network/ext/bc/C/rpc'
  };
### FILE: ./functions/src/utils/cryptoUtils.ts
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
### FILE: ./functions/src/utils/firestore.ts
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
### FILE: ./functions/src/utils/storageUtils.ts
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
### FILE: ./functions/src/test/sampleData.ts
// functions/src/test/sampleData.ts
export const sampleSeats = [
	{
		seatId: 'pc01',
		name: 'Gaming PC #1',
		status: 'available',
		ratePerMinute: 10,
		ipAddress: '192.168.1.101'
	},
	{
		seatId: 'pc02',
		name: 'Gaming PC #2',
		status: 'available',
		ratePerMinute: 10,
		ipAddress: '192.168.1.102'
	}
];

export const sampleUsers = [
	{
		userId: 'user1',
		displayName: '田中太郎',
		email: 'tanaka@example.com',
		memberUUID: 'fd9d1ee3-5b14-4904-9c02-75f87be640a3'
	}
];
### FILE: ./functions/src/index.ts
import * as admin from 'firebase-admin';

// Firebase初期化
admin.initializeApp();

// セッション関連の関数をエクスポート
//export { startSession } from './services/sessions/startSession';
export { startSessionHttp } from './services/sessions/startSessionHttp';
export { endSessionHttp } from './services/sessions/endSessionHttp';
export { generateBillingJSON } from './services/billing/generateBillingJSON';
export { saveHashToBlockchain } from './services/billing/saveHashToBlockchain';
export { saveSessionJson } from './services/billing/saveSessionJson';
### FILE: ./functions/lib/services/billing/saveHashToBlockchain.js
"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.saveHashToBlockchain = void 0;
const functions = __importStar(require("firebase-functions/v1"));
const admin = __importStar(require("firebase-admin"));
const ethers_1 = require("ethers");
const constants_1 = require("../../config/constants");
/**
 * ブロックチェーンへのハッシュ保存関数
 * 課金証明データのハッシュ値をAvalanche C-Chainに記録します
 */
exports.saveHashToBlockchain = functions.firestore
    .document(`${constants_1.COLLECTIONS.BILLING_PROOFS}/{billingId}`)
    .onCreate(async (snapshot, context) => {
    var _a;
    const newValue = snapshot.data();
    // 処理条件チェック（hash存在確認とステータス確認）
    if (!newValue.hash || newValue.status !== 'pending' || newValue.txId) {
        functions.logger.info(`処理をスキップ: BillingID=${context.params.billingId}, Status=${newValue.status}`);
        return null;
    }
    const billingId = context.params.billingId;
    try {
        functions.logger.info(`ブロックチェーン保存開始: BillingID=${billingId}, Hash=${newValue.hash}`);
        // プライベートキーを環境変数から取得
        const privateKey = (_a = functions.config().avalanche) === null || _a === void 0 ? void 0 : _a.privatekey;
        if (!privateKey) {
            throw new Error('Avalancheプライベートキーが設定されていません。FIREBASE_CONFIG.avalanche.privatekeyを設定してください。');
        }
        // Avalanche C-Chain RPCプロバイダーの設定
        const provider = new ethers_1.ethers.providers.JsonRpcProvider(constants_1.CHAIN_CONFIG.RPC_ENDPOINT);
        // ウォレットの初期化
        const wallet = new ethers_1.ethers.Wallet(privateKey, provider);
        // メタデータの準備
        const metadata = {
            billingId,
            type: 'gaming_cafe_billing',
            timestamp: Date.now(),
            projectId: process.env.GCLOUD_PROJECT || 'e-sports-sakura-b6a16'
        };
        // JSON形式のハッシュデータとメタデータ
        const dataToSend = JSON.stringify({
            hash: newValue.hash,
            metadata
        });
        functions.logger.info(`トランザクション送信準備: アドレス=${wallet.address}, データ長=${dataToSend.length}バイト`);
        // トランザクションの作成と送信
        // 自分自身に0 AVAXを送信し、データとしてハッシュを埋め込む
        const tx = await wallet.sendTransaction({
            to: wallet.address,
            value: ethers_1.ethers.utils.parseEther('0'),
            data: ethers_1.ethers.utils.hexlify(ethers_1.ethers.utils.toUtf8Bytes(dataToSend)),
            gasLimit: 100000
        });
        functions.logger.info(`トランザクション送信完了: TxHash=${tx.hash}`);
        // トランザクションの完了を待機
        const receipt = await tx.wait(1); // 1ブロックの確認を待つ
        functions.logger.info(`トランザクション確認完了: Block=${receipt.blockNumber}, GasUsed=${receipt.gasUsed.toString()}`);
        // Firestoreのデータを更新
        const db = admin.firestore();
        await db.collection(constants_1.COLLECTIONS.BILLING_PROOFS).doc(billingId).update({
            txId: receipt.transactionHash,
            blockNumber: receipt.blockNumber,
            status: 'confirmed',
            confirmedAt: admin.firestore.Timestamp.now()
        });
        functions.logger.info(`ブロックチェーン保存完了: BillingID=${billingId}, TxID=${receipt.transactionHash}, Block=${receipt.blockNumber}`);
        return {
            success: true,
            txId: receipt.transactionHash,
            blockNumber: receipt.blockNumber
        };
    }
    catch (error) {
        functions.logger.error('ブロックチェーン保存エラー:', error instanceof Error ? error.message : String(error));
        // エラー情報をFirestoreに記録
        const db = admin.firestore();
        await db.collection(constants_1.COLLECTIONS.BILLING_PROOFS).doc(billingId).update({
            status: 'error',
            errorMessage: error instanceof Error ? error.message : String(error),
            updatedAt: admin.firestore.Timestamp.now()
        });
        throw error;
    }
});
//# sourceMappingURL=saveHashToBlockchain.js.map
### FILE: ./functions/lib/services/billing/saveSessionJson.js
"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.saveSessionJson = void 0;
const functions = __importStar(require("firebase-functions/v1"));
const admin = __importStar(require("firebase-admin"));
const crypto = __importStar(require("crypto"));
const constants_1 = require("../../config/constants");
exports.saveSessionJson = functions.firestore
    .document(`${constants_1.COLLECTIONS.BILLING_QUEUE}/{docId}`)
    .onCreate(async (snapshot, context) => {
    var _a, _b;
    try {
        const { sessionId, userId, seatId } = snapshot.data();
        functions.logger.info(`セッションデータJSON生成開始: SessionID=${sessionId}, UserID=${userId}, SeatID=${seatId}`);
        const db = admin.firestore();
        // セッション詳細を取得
        const sessionDoc = await db.collection(constants_1.COLLECTIONS.SESSIONS).doc(sessionId).get();
        if (!sessionDoc.exists)
            throw new Error('セッションが見つかりません');
        const sessionData = sessionDoc.data();
        // 終了チェック
        if (sessionData.active || !sessionData.endTime) {
            throw new Error('セッションがまだ終了していません');
        }
        // ユーザー情報取得（オプション）
        const userDoc = await db.collection(constants_1.COLLECTIONS.USERS).doc(userId).get();
        const userData = userDoc.exists ? userDoc.data() : null;
        const membershipType = ((_a = userData === null || userData === void 0 ? void 0 : userData.stripe) === null || _a === void 0 ? void 0 : _a.paymentStatus) === 'active' ? 'premium' : 'standard';
        // JSON 構造の生成
        const billingJson = {
            sessionId,
            userId,
            seatId,
            startTime: sessionData.startTime instanceof admin.firestore.Timestamp
                ? sessionData.startTime.toDate().toISOString()
                : sessionData.startTime,
            endTime: sessionData.endTime instanceof admin.firestore.Timestamp
                ? sessionData.endTime.toDate().toISOString()
                : sessionData.endTime,
            duration: sessionData.duration,
            hourBlocks: (_b = sessionData.hourBlocks) !== null && _b !== void 0 ? _b : 0,
            memberType: membershipType,
            timestamp: Date.now()
        };
        const jsonString = JSON.stringify(billingJson, null, 2);
        // ファイル名・パスを JST で生成
        const now = new Date();
        const jstString = now
            .toLocaleString('ja-JP', {
            timeZone: 'Asia/Tokyo',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: false
        })
            .replace(/[\/\s:]/g, '');
        const fileName = `${jstString}_${sessionId}.json`;
        const storagePath = `sessionLog/${userId}/${fileName}`;
        // Cloud Storage に保存
        const bucket = admin.storage().bucket();
        await bucket.file(storagePath).save(jsonString, {
            contentType: 'application/json',
            metadata: { userId, sessionId }
        });
        // SHA256 ハッシュ
        const hashValue = crypto.createHash('sha256').update(jsonString).digest('hex');
        // Proofs コレクションに保存
        const proofData = {
            sessionId,
            userId,
            seatId,
            fileUrl: storagePath,
            hash: hashValue,
            status: 'pending',
            createdAt: admin.firestore.Timestamp.now()
        };
        await db.collection(constants_1.COLLECTIONS.BILLING_PROOFS).doc(sessionId).set(proofData);
        // キューの状態更新
        await snapshot.ref.update({
            status: 'processed',
            hashValue,
            updatedAt: admin.firestore.Timestamp.now()
        });
        functions.logger.info(`JSON生成完了: SessionID=${sessionId}, Hash=${hashValue}`);
        return { success: true, hashValue };
    }
    catch (error) {
        functions.logger.error('JSON生成エラー:', error instanceof Error ? error.message : String(error));
        await snapshot.ref.update({
            status: 'error',
            errorMessage: error instanceof Error ? error.message : String(error),
            updatedAt: admin.firestore.Timestamp.now()
        });
        throw error;
    }
});
//# sourceMappingURL=saveSessionJson.js.map
### FILE: ./functions/lib/services/billing/generateBillingJSON.js
"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.generateBillingJSON = void 0;
const functions = __importStar(require("firebase-functions/v1"));
const admin = __importStar(require("firebase-admin"));
const crypto = __importStar(require("crypto"));
const constants_1 = require("../../config/constants");
/**
 * 課金データJSON生成関数
 * 課金キューのデータを基に課金JSONを生成し、Cloud Storageに保存します
 */
exports.generateBillingJSON = functions.firestore
    .document(`${constants_1.COLLECTIONS.BILLING_QUEUE}/{docId}`)
    .onCreate(async (snapshot, context) => {
    var _a;
    try {
        const billingRequest = snapshot.data();
        const { sessionId, userId, seatId } = billingRequest;
        functions.logger.info(`課金データ生成開始: SessionID=${sessionId}, UserID=${userId}, SeatID=${seatId}`);
        // Firestoreデータベース参
        const db = admin.firestore();
        // セッション詳細を取得
        const sessionDoc = await db.collection(constants_1.COLLECTIONS.SESSIONS).doc(sessionId).get();
        if (!sessionDoc.exists) {
            throw new Error('セッションが見つかりません');
        }
        const sessionData = sessionDoc.data();
        // セッションが正常に終了しているか確認
        if (sessionData.active || !sessionData.endTime) {
            throw new Error('セッションがまだ終了していません');
        }
        // ユーザー情報を取得（オプション）
        const userDoc = await db.collection(constants_1.COLLECTIONS.USERS).doc(userId).get();
        const userData = userDoc.exists ? userDoc.data() : null;
        const membershipType = ((_a = userData === null || userData === void 0 ? void 0 : userData.stripe) === null || _a === void 0 ? void 0 : _a.paymentStatus) === 'active' ? 'premium' : 'standard';
        // 課金データの生成
        const billingId = `bill_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
        // 日時の変換
        const startTimeStr = sessionData.startTime instanceof admin.firestore.Timestamp
            ? sessionData.startTime.toDate().toISOString()
            : sessionData.startTime.toString();
        const endTimeStr = sessionData.endTime instanceof admin.firestore.Timestamp
            ? sessionData.endTime.toDate().toISOString()
            : sessionData.endTime.toString();
        // 課金JSONデータ構造
        const billingJson = {
            billingId,
            userId,
            sessionId,
            seatId,
            startTime: startTimeStr,
            endTime: endTimeStr,
            duration: sessionData.duration,
            timestamp: Date.now(),
            memberType: membershipType
        };
        // JSONを文字列に変換
        const jsonString = JSON.stringify(billingJson, null, 2);
        // ファイル名の生成
        const date = new Date();
        const yearMonth = `${date.getFullYear()}${(date.getMonth() + 1).toString().padStart(2, '0')}`;
        const timestamp = Date.now();
        const randomStr = Math.random().toString(36).substring(2, 8);
        const fileName = `billing_${yearMonth}_${userId}_${seatId}_${timestamp}_${randomStr}.json`;
        const storagePath = `userBillings/${fileName}`;
        // Cloud Storageに保存
        const bucket = admin.storage().bucket();
        const file = bucket.file(storagePath);
        await file.save(jsonString, {
            contentType: 'application/json',
            metadata: {
                userId,
                sessionId,
                billingId
            }
        });
        // SHA256ハッシュ計算
        const hashValue = crypto.createHash('sha256').update(jsonString).digest('hex');
        // billingProofsに保存するデータを準備
        const proofData = {
            billingId,
            userId,
            sessionId,
            seatId,
            fileUrl: storagePath,
            hash: hashValue,
            chainId: '43114',
            networkId: 1,
            txId: null,
            blockNumber: null,
            status: 'pending',
            createdAt: admin.firestore.Timestamp.now(),
            confirmedAt: null
        };
        // billingProofsコレクションに保存
        await db.collection(constants_1.COLLECTIONS.BILLING_PROOFS).doc(billingId).set(proofData);
        // セッションのbillingId参照のある場合は更新（新インターフェースではなくなったがバックワードコンパチビリティのため）
        try {
            await db.collection(constants_1.COLLECTIONS.SESSIONS).doc(sessionId).update({
                billingId
            });
        }
        catch (e) {
            functions.logger.warn(`SessionDocument does not have billingId field, skipping update.`);
        }
        // 課金キューの状態を更新
        await snapshot.ref.update({
            status: 'processed',
            billingId,
            hashValue,
            updatedAt: admin.firestore.Timestamp.now()
        });
        functions.logger.info(`課金データ生成完了: BillingID=${billingId}, Hash=${hashValue}`);
        return { success: true, billingId, hashValue };
    }
    catch (error) {
        functions.logger.error('課金データ生成エラー:', error instanceof Error ? error.message : String(error));
        // エラー情報を課金キューに記録
        await snapshot.ref.update({
            status: 'error',
            errorMessage: error instanceof Error ? error.message : String(error),
            updatedAt: admin.firestore.Timestamp.now()
        });
        throw error;
    }
});
//# sourceMappingURL=generateBillingJSON.js.map
### FILE: ./functions/lib/services/sessions/startSessionHttp.js
"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.startSessionHttp = void 0;
const functions = __importStar(require("firebase-functions"));
const admin = __importStar(require("firebase-admin"));
const constants_1 = require("../../config/constants");
/**
 * セッション開始HTTP関数
 */
exports.startSessionHttp = functions.https.onRequest(async (req, res) => {
    // CORSヘッダー設定
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Methods', 'GET, POST');
    res.set('Access-Control-Allow-Headers', 'Content-Type');
    // OPTIONS（プリフライト）
    if (req.method === 'OPTIONS') {
        res.status(204).send('');
        return;
    }
    if (req.method !== 'POST') {
        res.status(405).json({ success: false, error: 'Please use POST.' });
        return;
    }
    try {
        const { userId, seatId } = req.body;
        if (!userId || !seatId) {
            res.status(400).json({ success: false, error: 'userId and seatId are required.' });
            return;
        }
        const db = admin.firestore();
        const userDoc = await db.collection(constants_1.COLLECTIONS.USERS).doc(userId).get();
        if (!userDoc.exists) {
            res.status(404).json({ success: false, error: 'User not found.' });
            return;
        }
        const seatRef = db.collection(constants_1.COLLECTIONS.SEATS).doc(seatId);
        const seatDoc = await seatRef.get();
        if (!seatDoc.exists) {
            res.status(404).json({ success: false, error: 'Seat not found.' });
            return;
        }
        const seatData = seatDoc.data();
        if (seatData.status !== constants_1.SEAT_STATUS.AVAILABLE) {
            res.status(409).json({ success: false, error: `Seat not available. Status: ${seatData.status}` });
            return;
        }
        const activeQuery = await db
            .collection(constants_1.COLLECTIONS.SESSIONS)
            .where('seatId', '==', seatId)
            .where('active', '==', true)
            .limit(1)
            .get();
        if (!activeQuery.empty) {
            res.status(409).json({ success: false, error: 'An active session already exists.' });
            return;
        }
        const result = await db.runTransaction(async (tx) => {
            const sessionId = `sess_${Date.now()}_${Math.random().toString(36).slice(2)}`;
            // JST補正済 Timestamp を作成
            const now = new Date();
            const jstDate = new Date(now.getTime() + 9 * 60 * 60 * 1000);
            const startTime = admin.firestore.Timestamp.fromDate(jstDate);
            const sessionData = {
                sessionId,
                userId,
                seatId,
                startTime,
                endTime: '',
                pricePerHour: seatData.ratePerHour || 600,
                active: true,
                duration: 0
            };
            const sessionRef = db.collection(constants_1.COLLECTIONS.SESSIONS).doc(sessionId);
            tx.set(sessionRef, sessionData);
            tx.update(seatRef, { status: constants_1.SEAT_STATUS.IN_USE, updatedAt: admin.firestore.Timestamp.now() });
            return { sessionId, userId, seatId, startTime };
        });
        res.status(200).json({ success: true, message: 'Session started.', session: result });
    }
    catch (e) {
        functions.logger.error('startSessionHttp error:', e);
        res.status(500).json({ success: false, error: e.message });
    }
});
//# sourceMappingURL=startSessionHttp.js.map
### FILE: ./functions/lib/services/sessions/startSession.js
"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.startSession = void 0;
const functions = __importStar(require("firebase-functions"));
const admin = __importStar(require("firebase-admin"));
const constants_1 = require("../../config/constants");
/**
 * セッション開始関数
 * ユーザーIDと座席IDで認証を行い、新しいセッションを開始します
 */
exports.startSession = functions.https.onCall(async (data, context) => {
    // リクエストデータのログ出力（デバッグ用）
    functions.logger.info('Request data:', data);
    // データがnullまたは未定義の場合のチェック
    if (!data) {
        throw new functions.https.HttpsError('invalid-argument', 'リクエストデータが見つかりません');
    }
    const userId = data.userId;
    const seatId = data.seatId;
    // ユーザーIDとseatIdのチェック
    if (!userId || !seatId) {
        throw new functions.https.HttpsError('invalid-argument', 'ユーザーID(userId)と座席ID(seatId)は必須です');
    }
    // Firestoreデータベース参照
    const db = admin.firestore();
    try {
        // ユーザーIDの存在を確認
        const userRef = db.collection(constants_1.COLLECTIONS.USERS).doc(userId);
        const userDoc = await userRef.get();
        if (!userDoc.exists) {
            throw new functions.https.HttpsError('not-found', '指定されたユーザーIDが見つかりません');
        }
        // 次に、指定された座席IDの情報を取得
        const seatRef = db.collection(constants_1.COLLECTIONS.SEATS).doc(seatId);
        const seatDoc = await seatRef.get();
        if (!seatDoc.exists) {
            throw new functions.https.HttpsError('not-found', '指定された座席IDが見つかりません');
        }
        const seatData = seatDoc.data();
        // 座席が利用可能か確認
        if (seatData.status !== constants_1.SEAT_STATUS.AVAILABLE) {
            throw new functions.https.HttpsError('failed-precondition', `この座席は現在利用できません。状態: ${seatData.status}`);
        }
        // 既にアクティブなセッションがないか確認
        const sessionsRef = db.collection(constants_1.COLLECTIONS.SESSIONS);
        const activeSessionQuery = await sessionsRef
            .where('seatId', '==', seatId)
            .where('active', '==', true)
            .limit(1)
            .get();
        if (!activeSessionQuery.empty) {
            throw new functions.https.HttpsError('already-exists', 'この座席では既にアクティブなセッションが存在します');
        }
        // トランザクションを使用してセッション作成と座席状態更新を実行
        const result = await db.runTransaction(async (transaction) => {
            // 一意のセッションIDを生成
            const sessionId = `sess_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
            // 新しいセッションデータを作成
            const sessionData = {
                sessionId,
                userId,
                seatId,
                startTime: admin.firestore.Timestamp.now(),
                endTime: null,
                durationMinutes: 0,
                pricePerHour: seatData.ratePerHour || 400,
                amount: 0,
                active: true
            };
            // Firestoreにセッションを追加
            const sessionRef = db.collection(constants_1.COLLECTIONS.SESSIONS).doc(sessionId);
            transaction.set(sessionRef, sessionData);
            // 座席のステータスを更新
            transaction.update(seatRef, {
                status: constants_1.SEAT_STATUS.IN_USE,
                updatedAt: admin.firestore.Timestamp.now()
            });
            // 成功レスポンス用にセッション情報を返す
            return {
                sessionId,
                userId,
                seatId,
                startTime: sessionData.startTime
            };
        });
        functions.logger.info(`セッション開始成功: ${result.sessionId}, ユーザー: ${userId}, 座席: ${seatId}`);
        // 成功レスポンスを返す
        return {
            success: true,
            message: 'セッションが正常に開始されました',
            session: result
        };
    }
    catch (error) {
        // エラーログ
        functions.logger.error('セッション開始エラー:', error);
        // HTTPSエラーの場合はそのまま再スロー
        if (error instanceof functions.https.HttpsError) {
            throw error;
        }
        // その他のエラーは内部エラーとして処理
        throw new functions.https.HttpsError('internal', 'セッション開始中に内部エラーが発生しました', error instanceof Error ? error.message : String(error));
    }
});
//# sourceMappingURL=startSession.js.map
### FILE: ./functions/lib/services/sessions/endSessionHttp.js
"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.endSessionHttp = void 0;
const functions = __importStar(require("firebase-functions"));
const admin = __importStar(require("firebase-admin"));
const constants_1 = require("../../config/constants");
/**
 * セッション終了HTTP関数
 */
exports.endSessionHttp = functions.https.onRequest(async (req, res) => {
    // CORSヘッダー設定
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Methods', 'GET, POST');
    res.set('Access-Control-Allow-Headers', 'Content-Type');
    // OPTIONS（プリフライト）
    if (req.method === 'OPTIONS') {
        res.status(204).send('');
        return;
    }
    if (req.method !== 'POST') {
        res.status(405).json({ success: false, error: 'Please use POST.' });
        return;
    }
    try {
        const { sessionId, seatId } = req.body;
        if (!sessionId && !seatId) {
            res.status(400).json({ success: false, error: 'sessionId or seatId is required.' });
            return;
        }
        const db = admin.firestore();
        let ref = sessionId
            ? db.collection(constants_1.COLLECTIONS.SESSIONS).doc(sessionId)
            : (await db
                .collection(constants_1.COLLECTIONS.SESSIONS)
                .where('seatId', '==', seatId)
                .where('active', '==', true)
                .limit(1)
                .get()).docs[0].ref;
        const snap = await ref.get();
        if (!snap.exists) {
            res.status(404).json({ success: false, error: 'Session not found.' });
            return;
        }
        const data = snap.data();
        if (!data.active) {
            res.status(409).json({ success: false, error: 'Session already ended.' });
            return;
        }
        const result = await db.runTransaction(async (tx) => {
            // JST補正済 Timestamp
            const now = new Date();
            const jstDate = new Date(now.getTime() + 9 * 60 * 60 * 1000);
            const endTime = admin.firestore.Timestamp.fromDate(jstDate);
            const startMs = data.startTime.toMillis();
            const duration = Math.ceil((endTime.toMillis() - startMs) / 1000); // 秒単位
            const hourBlocks = Math.ceil(duration / 3600);
            tx.update(ref, { endTime, duration, hourBlocks, active: false });
            tx.update(db.collection(constants_1.COLLECTIONS.SEATS).doc(data.seatId), {
                status: constants_1.SEAT_STATUS.AVAILABLE,
                updatedAt: admin.firestore.Timestamp.now()
            });
            tx.set(db.collection(constants_1.COLLECTIONS.BILLING_QUEUE).doc(), {
                sessionId: data.sessionId,
                userId: data.userId,
                seatId: data.seatId,
                status: 'pending',
                createdAt: admin.firestore.Timestamp.now()
            });
            return { sessionId: data.sessionId, userId: data.userId, seatId: data.seatId, startTime: data.startTime, endTime, duration, hourBlocks };
        });
        res.status(200).json({ success: true, message: 'Session ended.', session: result });
    }
    catch (e) {
        functions.logger.error('endSessionHttp error:', e);
        res.status(500).json({ success: false, error: e.message });
    }
});
//# sourceMappingURL=endSessionHttp.js.map
### FILE: ./functions/lib/types/index.js
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
//# sourceMappingURL=index.js.map
### FILE: ./functions/lib/index.js
"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.saveSessionJson = exports.saveHashToBlockchain = exports.generateBillingJSON = exports.endSessionHttp = exports.startSessionHttp = void 0;
const admin = __importStar(require("firebase-admin"));
// Firebase初期化
admin.initializeApp();
// セッション関連の関数をエクスポート
//export { startSession } from './services/sessions/startSession';
var startSessionHttp_1 = require("./services/sessions/startSessionHttp");
Object.defineProperty(exports, "startSessionHttp", { enumerable: true, get: function () { return startSessionHttp_1.startSessionHttp; } });
var endSessionHttp_1 = require("./services/sessions/endSessionHttp");
Object.defineProperty(exports, "endSessionHttp", { enumerable: true, get: function () { return endSessionHttp_1.endSessionHttp; } });
var generateBillingJSON_1 = require("./services/billing/generateBillingJSON");
Object.defineProperty(exports, "generateBillingJSON", { enumerable: true, get: function () { return generateBillingJSON_1.generateBillingJSON; } });
var saveHashToBlockchain_1 = require("./services/billing/saveHashToBlockchain");
Object.defineProperty(exports, "saveHashToBlockchain", { enumerable: true, get: function () { return saveHashToBlockchain_1.saveHashToBlockchain; } });
var saveSessionJson_1 = require("./services/billing/saveSessionJson");
Object.defineProperty(exports, "saveSessionJson", { enumerable: true, get: function () { return saveSessionJson_1.saveSessionJson; } });
//# sourceMappingURL=index.js.map
### FILE: ./functions/lib/config/constants.js
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CHAIN_CONFIG = exports.BILLING_STATUS = exports.SEAT_STATUS = exports.SESSION_STATUS = exports.COLLECTIONS = void 0;
exports.COLLECTIONS = {
    USERS: 'users',
    SEATS: 'seats',
    SESSIONS: 'sessions',
    BILLING_PROOFS: 'billingProofs',
    BILLING_QUEUE: 'billingQueue'
};
exports.SESSION_STATUS = {
    ACTIVE: 'active',
    COMPLETED: 'completed',
    ERROR: 'error'
};
exports.SEAT_STATUS = {
    AVAILABLE: 'available',
    IN_USE: 'in-use',
    MAINTENANCE: 'maintenance'
};
exports.BILLING_STATUS = {
    PENDING: 'pending',
    PROCESSING: 'processing',
    CONFIRMED: 'confirmed',
    ERROR: 'error'
};
exports.CHAIN_CONFIG = {
    CHAIN_ID: '43114',
    NETWORK_ID: 1,
    RPC_ENDPOINT: 'https://api.avax.network/ext/bc/C/rpc'
};
//# sourceMappingURL=constants.js.map
### FILE: ./functions/lib/utils/storageUtils.js
"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.fileExists = exports.readFromStorage = exports.saveToStorage = void 0;
const admin = __importStar(require("firebase-admin"));
/**
 * Cloud Storageにファイルを保存する
 * @param path 保存先のパス
 * @param content ファイルの内容
 * @param options オプション（contentType, metadata等）
 * @returns ファイルのURLと保存結果
 */
const saveToStorage = async (path, content, options = {}) => {
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
exports.saveToStorage = saveToStorage;
/**
 * Cloud Storageからファイルを読み込む
 * @param path ファイルパス
 * @returns ファイルの内容
 */
const readFromStorage = async (path) => {
    const bucket = admin.storage().bucket();
    const file = bucket.file(path);
    const [content] = await file.download();
    return content;
};
exports.readFromStorage = readFromStorage;
/**
 * Cloud Storage内のファイルが存在するか確認
 * @param path ファイルパス
 * @returns 存在する場合はtrue
 */
const fileExists = async (path) => {
    const bucket = admin.storage().bucket();
    const file = bucket.file(path);
    const [exists] = await file.exists();
    return exists;
};
exports.fileExists = fileExists;
//# sourceMappingURL=storageUtils.js.map
### FILE: ./functions/lib/utils/firestore.js
"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.queryByField = exports.getDocumentById = exports.getCollection = exports.db = void 0;
const admin = __importStar(require("firebase-admin"));
// Firestoreデータベース参照を取得
exports.db = admin.firestore();
// コレクション参照を取得する汎用関数
const getCollection = (collectionName) => {
    return exports.db.collection(collectionName);
};
exports.getCollection = getCollection;
// ドキュメントIDで特定のドキュメントを取得
const getDocumentById = async (collectionName, documentId) => {
    const docRef = exports.db.collection(collectionName).doc(documentId);
    const doc = await docRef.get();
    if (!doc.exists) {
        return null;
    }
    return Object.assign(Object.assign({}, doc.data()), { id: doc.id });
};
exports.getDocumentById = getDocumentById;
// 単一条件でのクエリを実行
const queryByField = async (collectionName, fieldName, operator, value) => {
    const snapshot = await exports.db.collection(collectionName)
        .where(fieldName, operator, value)
        .get();
    return snapshot.docs.map(doc => (Object.assign(Object.assign({}, doc.data()), { id: doc.id })));
};
exports.queryByField = queryByField;
//# sourceMappingURL=firestore.js.map
### FILE: ./functions/lib/utils/cryptoUtils.js
"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.verifyTransactionData = exports.decodeTransactionData = exports.generateUniqueId = exports.verifyIntegrity = exports.calculateSHA256 = void 0;
const crypto = __importStar(require("crypto"));
/**
 * 文字列またはオブジェクトのSHA256ハッシュを計算する
 * @param data ハッシュ化するデータ（文字列またはオブジェクト）
 * @returns SHA256ハッシュ文字列（16進数）
 */
const calculateSHA256 = (data) => {
    // オブジェクトの場合は文字列に変換
    const content = typeof data === 'object' ? JSON.stringify(data) : data;
    // SHA256ハッシュを計算して16進数で返す
    return crypto.createHash('sha256').update(content).digest('hex');
};
exports.calculateSHA256 = calculateSHA256;
/**
 * データの整合性を検証する
 * @param data 検証するデータ
 * @param hash 期待されるハッシュ値
 * @returns 検証結果（true: 整合性あり、false: 整合性なし）
 */
const verifyIntegrity = (data, hash) => {
    const calculatedHash = (0, exports.calculateSHA256)(data);
    return calculatedHash === hash;
};
exports.verifyIntegrity = verifyIntegrity;
/**
 * ランダムなIDを生成する
 * @param prefix IDのプレフィックス
 * @param length ランダム部分の長さ
 * @returns 生成されたID
 */
const generateUniqueId = (prefix, length = 8) => {
    const randomPart = Math.random().toString(36).substring(2, 2 + length);
    const timestamp = Date.now().toString(36);
    return `${prefix}_${timestamp}_${randomPart}`;
};
exports.generateUniqueId = generateUniqueId;
/**
 * ブロックチェーンのトランザクションデータをデコードする
 * @param hexData 16進数形式のトランザクションデータ (0xプレフィックスあり/なし両方対応)
 * @returns デコードされたJSONオブジェクト
 */
const decodeTransactionData = (hexData) => {
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
    }
    catch (error) {
        console.error('JSON解析エラー:', error);
        return { error: 'JSONとして解析できませんでした', rawData: decodedString };
    }
};
exports.decodeTransactionData = decodeTransactionData;
/**
 * トランザクションデータの検証
 * @param hexData 16進数形式のトランザクションデータ
 * @param expectedHash 期待されるハッシュ値
 * @returns 検証結果
 */
const verifyTransactionData = (hexData, expectedHash) => {
    const decoded = (0, exports.decodeTransactionData)(hexData);
    return decoded && decoded.hash === expectedHash;
};
exports.verifyTransactionData = verifyTransactionData;
//# sourceMappingURL=cryptoUtils.js.map
### FILE: ./functions/lib/test/sampleData.js
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.sampleUsers = exports.sampleSeats = void 0;
// functions/src/test/sampleData.ts
exports.sampleSeats = [
    {
        seatId: 'pc01',
        name: 'Gaming PC #1',
        status: 'available',
        ratePerMinute: 10,
        ipAddress: '192.168.1.101'
    },
    {
        seatId: 'pc02',
        name: 'Gaming PC #2',
        status: 'available',
        ratePerMinute: 10,
        ipAddress: '192.168.1.102'
    }
];
exports.sampleUsers = [
    {
        userId: 'user1',
        displayName: '田中太郎',
        email: 'tanaka@example.com',
        memberUUID: 'fd9d1ee3-5b14-4904-9c02-75f87be640a3'
    }
];
//# sourceMappingURL=sampleData.js.map