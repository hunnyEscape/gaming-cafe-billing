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