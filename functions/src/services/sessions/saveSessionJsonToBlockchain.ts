// ./functions/src/services/billing/saveSessionJsonToBlockchain.ts
import * as functions from 'firebase-functions/v1';
import * as admin from 'firebase-admin';
import { ethers } from 'ethers';
import { COLLECTIONS, CHAIN_CONFIG } from '../../config/constants';
import { SessionDocument } from '../../types';

/**
 * セッションデータをJSON形式でブロックチェーンに直接保存する関数
 * セッション終了時に呼び出され、セッションデータをAvalanche C-Chainに記録します
 */

export const saveSessionJsonToBlockchain = functions.firestore
	.document(`${COLLECTIONS.SESSIONS}/{sessionId}`)
	.onUpdate(async (change, context) => {
		const before = change.before.data() as SessionDocument;
		const after = change.after.data() as SessionDocument;
		const sessionId = context.params.sessionId;

		// セッションがactive=trueからfalseに変わった時だけ処理（セッション終了時）
		if (before.active === true && after.active === false && after.endTime) {
			const db = admin.firestore();

			try {
				functions.logger.info(`ブロックチェーン保存開始: SessionID=${sessionId}`);

				// Timestamp を ISO8601 文字列に変換
				const toJstIso = (value: admin.firestore.Timestamp | string): string => {
					const date = value instanceof admin.firestore.Timestamp
						? value.toDate()
						: new Date(value);

					// JST補正（+9時間）
					const jstDate = new Date(date.getTime() + 9 * 60 * 60 * 1000);
					return jstDate.toISOString().replace('Z', '+09:00');
				};

				// JSONデータの作成 - 指定された順序で
				const sessionJson = {
					sessionId,
					seatId: after.seatId,
					startTime: toJstIso(after.startTime),
					endTime: toJstIso(after.endTime),
					hourBlocks: after.hourBlocks || 0
				};

				// JSON文字列化
				const jsonString = JSON.stringify(sessionJson);

				// プライベートキーを環境変数から取得
				const privateKey = functions.config().avalanche?.privatekey;

				if (!privateKey) {
					throw new Error('Avalanche private key not configured');
				}

				// Avalanche C-Chain RPCプロバイダー初期化
				const provider = new ethers.providers.JsonRpcProvider(CHAIN_CONFIG.RPC_ENDPOINT);

				// ウォレット初期化
				const wallet = new ethers.Wallet(privateKey, provider);

				functions.logger.info(`トランザクション送信準備: データ長=${jsonString.length}バイト`);

				// トランザクション送信 - JSONデータを直接含める
				const tx = await wallet.sendTransaction({
					to: wallet.address, // 自分自身に送信
					value: ethers.utils.parseEther('0'), // 0 AVAX
					data: ethers.utils.hexlify(ethers.utils.toUtf8Bytes(jsonString)),
					gasLimit: 200000 // JSON全体を保存するので少し多めに
				});

				functions.logger.info(`トランザクション送信完了: TxHash=${tx.hash}`);

				// トランザクションの完了を待機（1ブロック確認）
				const receipt = await tx.wait(1);

				functions.logger.info(`トランザクション確認完了: Block=${receipt.blockNumber}, GasUsed=${receipt.gasUsed.toString()}`);

				// セッションドキュメントの更新
				const sessionRef = db.collection(COLLECTIONS.SESSIONS).doc(sessionId);
				await sessionRef.update({
					blockchainStatus: 'confirmed',
					blockchainTxId: receipt.transactionHash,
					blockchainBlockNumber: receipt.blockNumber,
					blockchainConfirmedAt: admin.firestore.Timestamp.now(),
					blockchainChainId: CHAIN_CONFIG.CHAIN_ID,
					blockchainNetworkId: CHAIN_CONFIG.NETWORK_ID
				});

				functions.logger.info(`ブロックチェーン保存完了: SessionID=${sessionId}, TxID=${receipt.transactionHash}`);

				return {
					success: true,
					txId: receipt.transactionHash,
					blockNumber: receipt.blockNumber
				};

			} catch (error) {
				functions.logger.error('ブロックチェーン保存エラー:', error instanceof Error ? error.message : String(error));

				// エラー時はセッションステータスを更新
				try {
					const sessionRef = db.collection(COLLECTIONS.SESSIONS).doc(sessionId);
					await sessionRef.update({
						blockchainStatus: 'error',
						blockchainErrorMessage: error instanceof Error ? error.message : String(error),
						blockchainConfirmedAt: admin.firestore.Timestamp.now()
					});
				} catch (updateError) {
					functions.logger.error('Session update error:', updateError);
				}

				throw error;
			}
		}

		return null; // セッション終了イベントでない場合は何もしない
	});