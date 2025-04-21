import * as functions from 'firebase-functions/v1';
import Stripe from 'stripe';

// Stripe設定
const getStripeInstance = (): Stripe => {
  // v1の方法で環境変数を取得
  const secretKey = functions.config().stripe?.secret_key;
  
  if (!secretKey) {
    throw new Error('Stripe secret key is not configured. Please run: firebase functions:config:set stripe.secret_key="sk_test_..."');
  }
  
  return new Stripe(secretKey, {
    apiVersion: '2025-03-31.basil',
    typescript: true,
  });
};

// シングルトンパターンでStripeインスタンスを管理
let stripeInstance: Stripe | null = null;

export const getStripe = (): Stripe => {
  if (!stripeInstance) {
    stripeInstance = getStripeInstance();
  }
  return stripeInstance;
};

// エラーハンドリング
export const handleStripeError = (error: any, context: string): string => {
  // エラーログ
  console.error(`Stripe error in ${context}:`, error);
  
  // エラータイプに基づいたメッセージ
  if (error.type === 'StripeCardError') {
    return `支払い方法が拒否されました: ${error.message}`;
  } else if (error.type === 'StripeInvalidRequestError') {
    return `無効なリクエスト: ${error.message}`;
  } else if (error.type === 'StripeAPIError') {
    return 'Stripe APIエラー。しばらく経ってからもう一度お試しください。';
  } else if (error.type === 'StripeConnectionError') {
    return 'Stripeとの接続エラー。しばらく経ってからもう一度お試しください。';
  } else if (error.type === 'StripeAuthenticationError') {
    return 'システムエラーが発生しました。管理者にお問い合わせください。';
  } else {
    return '請求書の処理中にエラーが発生しました。';
  }
};

// 再試行ロジック
export const retryStripeOperation = async <T>(
  operation: () => Promise<T>,
  maxRetries = 3,
  delay = 1000
): Promise<T> => {
  let lastError: any;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error: any) {
      lastError = error;
      
      // 一時的なエラーのみ再試行
      if (
        error.type === 'StripeConnectionError' ||
        error.type === 'StripeAPIError' ||
        (error.type === 'StripeInvalidRequestError' && error.code === 'rate_limit')
      ) {
        console.log(`Stripe API attempt ${attempt} failed, retrying in ${delay}ms...`);
        await new Promise(resolve => setTimeout(resolve, delay));
        delay *= 2; // 指数バックオフ
      } else {
        // 一時的でないエラーはすぐに失敗
        throw error;
      }
    }
  }
  
  // すべての再試行が失敗
  throw lastError;
};