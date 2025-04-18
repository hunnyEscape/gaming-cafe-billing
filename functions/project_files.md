-e 
### FILE: ./src/services/billing/generateBillingJSON.ts

import * as functions from 'firebase-functions/v1';
import * as admin from 'firebase-admin';
import * as crypto from 'crypto';
import { COLLECTIONS } from '../../config/constants';
import { Session } from '../../types';

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

			// Firestoreデータベース参照
			const db = admin.firestore();

			// セッション詳細を取得
			const sessionDoc = await db.collection(COLLECTIONS.SESSIONS).doc(sessionId).get();

			if (!sessionDoc.exists) {
				throw new Error('セッションが見つかりません');
			}

			const sessionData = sessionDoc.data() as Session;

			// セッションが正常に終了しているか確認
			if (sessionData.active || !sessionData.endTime) {
				throw new Error('セッションがまだ終了していません');
			}

			// ユーザー情報を取得（オプション）
			const userDoc = await db.collection(COLLECTIONS.USERS).doc(userId).get();
			const userData = userDoc.exists ? userDoc.data() : { membershipType: 'standard' };

			// 課金データの生成
			const billingId = `bill_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
			const startTimeStr = sessionData.startTime.toDate().toISOString();
			const endTimeStr = sessionData.endTime.toDate().toISOString();

			// 課金JSONデータ構造
			const billingJson = {
				billingId,
				userId,
				sessionId,
				seatId,
				startTime: startTimeStr,
				endTime: endTimeStr,
				duration: sessionData.durationMinutes,
				fee: sessionData.amount,
				timestamp: new Date().toISOString(),
				memberType: userData?.membershipType || 'standard'
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

			// セッションのbillingIdを更新
			await db.collection(COLLECTIONS.SESSIONS).doc(sessionId).update({
				billingId
			});

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
	});-e 
### FILE: ./src/services/billing/saveHashToBlockchain.ts

import * as functions from 'firebase-functions/v1';
import * as admin from 'firebase-admin';
import { ethers } from 'ethers';
import { COLLECTIONS, CHAIN_CONFIG } from '../../config/constants';

/**
 * ブロックチェーンへのハッシュ保存関数
 * 課金証明データのハッシュ値をAvalanche C-Chainに記録します
 */
export const saveHashToBlockchain = functions.firestore
	.document(`${COLLECTIONS.BILLING_PROOFS}/{billingId}`)
	.onCreate(async (snapshot, context) => {
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
	});-e 
### FILE: ./src/services/sessions/endSessionHttp.ts

import * as functions from 'firebase-functions';
import * as admin from 'firebase-admin';
import { COLLECTIONS, SEAT_STATUS } from '../../config/constants';
import { Session } from '../../types';

/**
 * セッション終了HTTP関数
 * セッションIDまたは座席IDを受け取り、セッションを終了して利用料金を計算します
 */
export const endSessionHttp = functions.https.onRequest(async (req, res) => {
	// CORSヘッダー設定
	res.set('Access-Control-Allow-Origin', '*');
	res.set('Access-Control-Allow-Methods', 'GET, POST');
	res.set('Access-Control-Allow-Headers', 'Content-Type');

	// OPTIONSリクエスト（プリフライト）への対応
	if (req.method === 'OPTIONS') {
		res.status(204).send('');
		return;
	}

	// POSTメソッド以外は受け付けない
	if (req.method !== 'POST') {
		res.status(405).json({
			success: false,
			error: 'Method not allowed. Please use POST.'
		});
		return;
	}

	try {
		// リクエストデータのログ出力（デバッグ用）
		functions.logger.info('Request body:', req.body);

		const data = req.body;

		// データがnullまたは未定義の場合のチェック
		if (!data) {
			res.status(400).json({
				success: false,
				error: 'リクエストデータが見つかりません'
			});
			return;
		}

		const sessionId = data.sessionId;
		const seatId = data.seatId;

		// セッションIDまたは座席IDのどちらかは必須
		if (!sessionId && !seatId) {
			res.status(400).json({
				success: false,
				error: 'セッションID(sessionId)または座席ID(seatId)のいずれかが必要です'
			});
			return;
		}

		// Firestoreデータベース参照
		const db = admin.firestore();

		// セッションの検索
		let sessionRef: FirebaseFirestore.DocumentReference<FirebaseFirestore.DocumentData>;
		let sessionDoc: FirebaseFirestore.DocumentSnapshot<FirebaseFirestore.DocumentData>;

		if (sessionId) {
			// セッションIDが指定された場合は直接取得
			sessionRef = db.collection(COLLECTIONS.SESSIONS).doc(sessionId);
			sessionDoc = await sessionRef.get();

			if (!sessionDoc.exists) {
				res.status(404).json({
					success: false,
					error: '指定されたセッションIDが見つかりません'
				});
				return;
			}
		} else {
			// 座席IDからアクティブなセッションを検索
			const sessionsRef = db.collection(COLLECTIONS.SESSIONS);
			const activeSessionQuery = await sessionsRef
				.where('seatId', '==', seatId)
				.where('active', '==', true)
				.limit(1)
				.get();

			if (activeSessionQuery.empty) {
				res.status(404).json({
					success: false,
					error: 'この座席でアクティブなセッションが見つかりません'
				});
				return;
			}

			sessionDoc = activeSessionQuery.docs[0];
			sessionRef = sessionDoc.ref;
		}

		const sessionData = sessionDoc.data() as Session;

		// 既に終了しているセッションの場合はエラー
		if (!sessionData.active) {
			res.status(409).json({
				success: false,
				error: 'このセッションはすでに終了しています'
			});
			return;
		}

		// トランザクションによるセッション終了処理
		const result = await db.runTransaction(async (transaction) => {
			// 現在時刻を終了時間として設定
			const endTime = admin.firestore.Timestamp.now();

			// 利用時間の計算（分単位、切り上げ）
			const startTimeMs = sessionData.startTime.toMillis();
			const endTimeMs = endTime.toMillis();
			const durationMinutes = Math.ceil((endTimeMs - startTimeMs) / (1000 * 60));

			// 料金の計算
			const amount = durationMinutes * sessionData.pricePerMinute;

			// セッション情報の更新
			transaction.update(sessionRef, {
				endTime: endTime,
				durationMinutes: durationMinutes,
				amount: amount,
				active: false
			});

			// 座席のステータスを「available」に戻す
			const seatRef = db.collection(COLLECTIONS.SEATS).doc(sessionData.seatId);
			transaction.update(seatRef, {
				status: SEAT_STATUS.AVAILABLE,
				updatedAt: admin.firestore.Timestamp.now()
			});

			// 課金キューの作成（後続の課金処理用、オプション）
			const billingQueueRef = db.collection(COLLECTIONS.BILLING_QUEUE).doc();
			transaction.set(billingQueueRef, {
				sessionId: sessionData.sessionId,
				userId: sessionData.userId,
				seatId: sessionData.seatId,
				status: 'pending',
				createdAt: admin.firestore.Timestamp.now()
			});

			// 結果を返す
			return {
				sessionId: sessionData.sessionId,
				userId: sessionData.userId,
				seatId: sessionData.seatId,
				startTime: sessionData.startTime,
				endTime: endTime,
				durationMinutes: durationMinutes,
				amount: amount
			};
		});

		functions.logger.info(`セッション終了成功: ${result.sessionId}, 利用時間: ${result.durationMinutes}分, 料金: ${result.amount}円`);

		// 成功レスポンスを返す
		res.status(200).json({
			success: true,
			message: 'セッションが正常に終了しました',
			session: result
		});
	} catch (error: unknown) {
		// エラーログ
		functions.logger.error('セッション終了エラー:', error);

		// エラーレスポンスを返す
		res.status(500).json({
			success: false,
			error: error instanceof Error ? error.message : 'セッション終了中に内部エラーが発生しました'
		});
	}
});-e 
### FILE: ./src/services/sessions/startSessionHttp.ts

import * as functions from 'firebase-functions';
import * as admin from 'firebase-admin';
import { COLLECTIONS, SEAT_STATUS } from '../../config/constants';
import { Session, Seat } from '../../types';

/**
 * セッション開始HTTP関数
 * ユーザーIDと座席IDで認証を行い、新しいセッションを開始します
 */
export const startSessionHttp = functions.https.onRequest(async (req, res) => {
	// CORSヘッダー設定
	res.set('Access-Control-Allow-Origin', '*');
	res.set('Access-Control-Allow-Methods', 'GET, POST');
	res.set('Access-Control-Allow-Headers', 'Content-Type');

	// OPTIONSリクエスト（プリフライト）への対応
	if (req.method === 'OPTIONS') {
		res.status(204).send('');
		return;
	}

	// POSTメソッド以外は受け付けない
	if (req.method !== 'POST') {
		res.status(405).json({
			success: false,
			error: 'Method not allowed. Please use POST.'
		});
		return;
	}

	try {
		// リクエストデータのログ出力（デバッグ用）
		functions.logger.info('Request body:', req.body);

		const data = req.body;

		// データがnullまたは未定義の場合のチェック
		if (!data) {
			res.status(400).json({
				success: false,
				error: 'リクエストデータが見つかりません'
			});
			return;
		}

		const userId = data.userId;
		const seatId = data.seatId;

		// ユーザーIDとseatIdのチェック
		if (!userId || !seatId) {
			res.status(400).json({
				success: false,
				error: 'ユーザーID(userId)と座席ID(seatId)は必須です'
			});
			return;
		}

		// Firestoreデータベース参照
		const db = admin.firestore();

		// ユーザーIDの存在を確認
		const userRef = db.collection(COLLECTIONS.USERS).doc(userId);
		const userDoc = await userRef.get();

		if (!userDoc.exists) {
			res.status(404).json({
				success: false,
				error: '指定されたユーザーIDが見つかりません'
			});
			return;
		}

		// 次に、指定された座席IDの情報を取得
		const seatRef = db.collection(COLLECTIONS.SEATS).doc(seatId);
		const seatDoc = await seatRef.get();

		if (!seatDoc.exists) {
			res.status(404).json({
				success: false,
				error: '指定された座席IDが見つかりません'
			});
			return;
		}

		const seatData = seatDoc.data() as Seat;

		// 座席が利用可能か確認
		if (seatData.status !== SEAT_STATUS.AVAILABLE) {
			res.status(409).json({
				success: false,
				error: `この座席は現在利用できません。状態: ${seatData.status}`
			});
			return;
		}

		// 既にアクティブなセッションがないか確認
		const sessionsRef = db.collection(COLLECTIONS.SESSIONS);
		const activeSessionQuery = await sessionsRef
			.where('seatId', '==', seatId)
			.where('active', '==', true)
			.limit(1)
			.get();

		if (!activeSessionQuery.empty) {
			res.status(409).json({
				success: false,
				error: 'この座席では既にアクティブなセッションが存在します'
			});
			return;
		}

		// トランザクションを使用してセッション作成と座席状態更新を実行
		const result = await db.runTransaction(async (transaction) => {
			// 一意のセッションIDを生成
			const sessionId = `sess_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;

			// 新しいセッションデータを作成
			const sessionData: Session = {
				sessionId,
				userId,
				seatId,
				startTime: admin.firestore.Timestamp.now(),
				endTime: null,
				durationMinutes: 0,
				pricePerMinute: seatData.ratePerMinute || 10, // デフォルト料金: 10円/分
				amount: 0,
				active: true,
				billingId: null
			};

			// Firestoreにセッションを追加
			const sessionRef = db.collection(COLLECTIONS.SESSIONS).doc(sessionId);
			transaction.set(sessionRef, sessionData);

			// 座席のステータスを更新
			transaction.update(seatRef, {
				status: SEAT_STATUS.IN_USE,
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
		res.status(200).json({
			success: true,
			message: 'セッションが正常に開始されました',
			session: result
		});
	} catch (error: unknown) {
		// エラーログ
		functions.logger.error('セッション開始エラー:', error);

		// エラーレスポンスを返す
		res.status(500).json({
			success: false,
			error: error instanceof Error ? error.message : 'セッション開始中に内部エラーが発生しました'
		});
	}
});-e 
### FILE: ./src/services/sessions/startSession.ts

import * as functions from 'firebase-functions';
import * as admin from 'firebase-admin';
import { COLLECTIONS, SEAT_STATUS } from '../../config/constants';
import { Session, Seat } from '../../types';

/**
 * セッション開始関数
 * ユーザーIDと座席IDで認証を行い、新しいセッションを開始します
 */
export const startSession = functions.https.onCall(async (data: any, context) => {
	// リクエストデータのログ出力（デバッグ用）
	functions.logger.info('Request data:', data);

	// データがnullまたは未定義の場合のチェック
	if (!data) {
		throw new functions.https.HttpsError(
			'invalid-argument',
			'リクエストデータが見つかりません'
		);
	}

	const userId = data.userId;
	const seatId = data.seatId;

	// ユーザーIDとseatIdのチェック
	if (!userId || !seatId) {
		throw new functions.https.HttpsError(
			'invalid-argument',
			'ユーザーID(userId)と座席ID(seatId)は必須です'
		);
	}

	// Firestoreデータベース参照
	const db = admin.firestore();

	try {
		// ユーザーIDの存在を確認
		const userRef = db.collection(COLLECTIONS.USERS).doc(userId);
		const userDoc = await userRef.get();

		if (!userDoc.exists) {
			throw new functions.https.HttpsError(
				'not-found',
				'指定されたユーザーIDが見つかりません'
			);
		}

		// 次に、指定された座席IDの情報を取得
		const seatRef = db.collection(COLLECTIONS.SEATS).doc(seatId);
		const seatDoc = await seatRef.get();

		if (!seatDoc.exists) {
			throw new functions.https.HttpsError(
				'not-found',
				'指定された座席IDが見つかりません'
			);
		}

		const seatData = seatDoc.data() as Seat;

		// 座席が利用可能か確認
		if (seatData.status !== SEAT_STATUS.AVAILABLE) {
			throw new functions.https.HttpsError(
				'failed-precondition',
				`この座席は現在利用できません。状態: ${seatData.status}`
			);
		}

		// 既にアクティブなセッションがないか確認
		const sessionsRef = db.collection(COLLECTIONS.SESSIONS);
		const activeSessionQuery = await sessionsRef
			.where('seatId', '==', seatId)
			.where('active', '==', true)
			.limit(1)
			.get();

		if (!activeSessionQuery.empty) {
			throw new functions.https.HttpsError(
				'already-exists',
				'この座席では既にアクティブなセッションが存在します'
			);
		}

		// トランザクションを使用してセッション作成と座席状態更新を実行
		const result = await db.runTransaction(async (transaction) => {
			// 一意のセッションIDを生成
			const sessionId = `sess_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;

			// 新しいセッションデータを作成
			const sessionData: Session = {
				sessionId,
				userId,
				seatId,
				startTime: admin.firestore.Timestamp.now(),
				endTime: null,
				durationMinutes: 0,
				pricePerMinute: seatData.ratePerMinute || 10, // デフォルト料金: 10円/分
				amount: 0,
				active: true,
				billingId: null
			};

			// Firestoreにセッションを追加
			const sessionRef = db.collection(COLLECTIONS.SESSIONS).doc(sessionId);
			transaction.set(sessionRef, sessionData);

			// 座席のステータスを更新
			transaction.update(seatRef, {
				status: SEAT_STATUS.IN_USE,
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

	} catch (error: unknown) {
		// エラーログ
		functions.logger.error('セッション開始エラー:', error);

		// HTTPSエラーの場合はそのまま再スロー
		if (error instanceof functions.https.HttpsError) {
			throw error;
		}

		// その他のエラーは内部エラーとして処理
		throw new functions.https.HttpsError(
			'internal',
			'セッション開始中に内部エラーが発生しました',
			error instanceof Error ? error.message : String(error)
		);
	}
});-e 
### FILE: ./src/types/index.ts

import { Timestamp } from 'firebase-admin/firestore';

export interface User {
  userId: string;
  displayName: string;
  email: string;
  memberUUID: string;
  membershipType?: string;
  totalUsageMinutes?: number;
}

export interface Seat {
  seatId: string;
  name: string;
  macAddress?: string;
  ipAddress?: string;
  status: string;
  ratePerMinute: number;
  lastMaintenanceAt?: Timestamp;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface Session {
  sessionId: string;
  userId: string;
  seatId: string;
  startTime: Timestamp;
  endTime: Timestamp | null;
  durationMinutes: number;
  pricePerMinute: number;
  amount: number;
  active: boolean;
  billingId: string | null;
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
}-e 
### FILE: ./src/config/constants.ts

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
  };-e 
### FILE: ./src/utils/cryptoUtils.ts

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
  };-e 
### FILE: ./src/utils/firestore.ts

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
};-e 
### FILE: ./src/utils/storageUtils.ts

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
 * @returns ファイルの内
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
};-e 
### FILE: ./src/test/sampleData.ts

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
];-e 
### FILE: ./src/index.ts

import * as admin from 'firebase-admin';

// Firebase初期化
admin.initializeApp();

// セッション関連の関数をエクスポート
export { startSession } from './services/sessions/startSession';
export { startSessionHttp } from './services/sessions/startSessionHttp';
export { endSessionHttp } from './services/sessions/endSessionHttp';
export { generateBillingJSON } from './services/billing/generateBillingJSON';
export { saveHashToBlockchain } from './services/billing/saveHashToBlockchain';