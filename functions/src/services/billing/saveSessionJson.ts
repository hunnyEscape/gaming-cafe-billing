import * as functions from 'firebase-functions/v1';
import * as admin from 'firebase-admin';
import * as crypto from 'crypto';
import { COLLECTIONS } from '../../config/constants';
import { SessionDocument, UserDocument } from '../../types';

export const saveSessionJson = functions.firestore
	.document(`${COLLECTIONS.BILLING_QUEUE}/{docId}`)
	.onCreate(async (snapshot, context) => {
		try {
			const billingRequest = snapshot.data();
			const { sessionId, userId, seatId } = billingRequest;

			functions.logger.info(
				`課金データ生成開始: SessionID=${sessionId}, UserID=${userId}, SeatID=${seatId}`
			);

			const db = admin.firestore();

			// セッション詳細を取得
			const sessionDoc = await db
				.collection(COLLECTIONS.SESSIONS)
				.doc(sessionId)
				.get();
			if (!sessionDoc.exists) {
				throw new Error('セッションが見つかりません');
			}
			const sessionData = sessionDoc.data() as SessionDocument;

			// セッションが正常に終了しているか確認
			if (sessionData.active || !sessionData.endTime) {
				throw new Error('セッションがまだ終了していません');
			}

			// ユーザー情報を取得（オプション）
			const userDoc = await db
				.collection(COLLECTIONS.USERS)
				.doc(userId)
				.get();
			const userData = userDoc.exists
				? (userDoc.data() as UserDocument)
				: null;
			const membershipType =
				userData?.stripe?.paymentStatus === 'active'
					? 'premium'
					: 'standard';

			// 課金データの生成
			const billingId = `bill_${Date.now()}_${Math.random()
				.toString(36)
				.substring(2, 9)}`;

			// 日時の変換
			const startTimeStr =
				sessionData.startTime instanceof admin.firestore.Timestamp
					? sessionData.startTime.toDate().toISOString()
					: sessionData.startTime.toString();
			const endTimeStr =
				sessionData.endTime instanceof admin.firestore.Timestamp
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
				duration: sessionData.durationMinutes,
				fee: sessionData.amount,
				timestamp: Date.now(),
				memberType: membershipType
			};

			// JSONを文字列に変換
			const jsonString = JSON.stringify(billingJson, null, 2);

			// —————— ここから変更 ——————
			// 日本時間 (JST) でファイル名を作成 (YYYYMMDDHHMMSS形式)
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
				.replace(/[\/\s:]/g, ''); // => "20250419153045" のような文字列

			const fileName = `${jstString}_${sessionId}.json`;
			const storagePath = `sessionLog/${userId}/${fileName}`;
			// —————— ここまで変更 ——————

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
			const hashValue = crypto
				.createHash('sha256')
				.update(jsonString)
				.digest('hex');

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
			await db
				.collection(COLLECTIONS.BILLING_PROOFS)
				.doc(billingId)
				.set(proofData);

			// セッションへの billingId 追記（バックワード互換）
			try {
				await db
					.collection(COLLECTIONS.SESSIONS)
					.doc(sessionId)
					.update({ billingId });
			} catch {
				functions.logger.warn(
					`SessionDocument does not have billingId field, skipping update.`
				);
			}

			// 課金キューの状態を更新
			await snapshot.ref.update({
				status: 'processed',
				billingId,
				hashValue,
				updatedAt: admin.firestore.Timestamp.now()
			});

			functions.logger.info(
				`課金データ生成完了: BillingID=${billingId}, Hash=${hashValue}`
			);
			return { success: true, billingId, hashValue };
		} catch (error) {
			functions.logger.error(
				'課金データ生成エラー:',
				error instanceof Error ? error.message : String(error)
			);
			// エラー情報を課金キューに記録
			await snapshot.ref.update({
				status: 'error',
				errorMessage:
					error instanceof Error ? error.message : String(error),
				updatedAt: admin.firestore.Timestamp.now()
			});
			throw error;
		}
	});
