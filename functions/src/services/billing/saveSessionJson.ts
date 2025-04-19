import * as functions from 'firebase-functions/v1';
import * as admin from 'firebase-admin';
import * as crypto from 'crypto';
import { COLLECTIONS } from '../../config/constants';
import { SessionDocument } from '../../types';

/**
 * セッション JSON 保存 & Session ドキュメントにメタ情報を追加
 */
export const saveSessionJson = functions.firestore
	.document(`${COLLECTIONS.BILLING_QUEUE}/{docId}`)
	.onCreate(async (snapshot, context) => {
		try {
			const { sessionId, userId, seatId } = snapshot.data() as {
				sessionId: string;
				userId: string;
				seatId: string;
			};

			const db = admin.firestore();
			const sessionRef = db.collection(COLLECTIONS.SESSIONS).doc(sessionId);
			const sessionSnap = await sessionRef.get();
			if (!sessionSnap.exists) throw new Error('Session not found');

			const sessionData = sessionSnap.data() as SessionDocument;
			if (sessionData.active || !sessionData.endTime) {
				throw new Error('Session has not ended yet');
			}

			// Timestamp を ISO8601 文字列に統一
			const toIso = (value: admin.firestore.Timestamp | string): string => {
				if (value instanceof admin.firestore.Timestamp) {
					return value.toDate().toISOString();
				}
				return typeof value === 'string' ? new Date(value).toISOString() : '';
			};

			// キーをソートして一貫性を担保
			const sessionJson: Record<string, any> = {
				sessionId,
				userId,
				seatId,
				startTime: toIso(sessionData.startTime),
				endTime: toIso(sessionData.endTime),
				duration: sessionData.duration,
				hourBlocks: sessionData.hourBlocks || 0
			};
			const orderedKeys = Object.keys(sessionJson).sort();
			const canonicalJson = orderedKeys.reduce((obj, key) => {
				obj[key] = sessionJson[key];
				return obj;
			}, {} as Record<string, any>);

			// Minify (空白改行なし)
			const jsonString = JSON.stringify(canonicalJson);

			// Cloud Storage に保存
			const bucket = admin.storage().bucket();
			const storagePath = `sessionLog/${userId}/${sessionId}.json`;
			await bucket.file(storagePath).save(jsonString, {
				contentType: 'application/json'
			});

			// SHA256 ハッシュ計算
			const jsonHash = crypto.createHash('sha256').update(jsonString).digest('hex');
			const now = admin.firestore.Timestamp.now();

			// Session ドキュメントに更新
			await sessionRef.update({
				storageUrl: storagePath,
				jsonHash,
				jsonSavedAt: now,
				blockchainStatus: 'pending',
				blockchainTxId: null,
				blockchainBlockNumber: null,
				blockchainConfirmedAt: null,
				blockchainChainId: null,
				blockchainNetworkId: null
			});

			// billingQueue 側ステータス更新
			await snapshot.ref.update({
				status: 'processed',
				updatedAt: now
			});

			return { success: true };
		} catch (error) {
			const now = admin.firestore.Timestamp.now();
			await snapshot.ref.update({
				status: 'error',
				errorMessage: error instanceof Error ? error.message : String(error),
				updatedAt: now
			});
			throw error;
		}
	});
