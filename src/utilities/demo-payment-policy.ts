export function assertDemoStripeKeys(env: Record<string, string | undefined>) {
  if (env.STRIPE_SECRET_KEY && !env.STRIPE_SECRET_KEY.startsWith('sk_test_')) throw new Error('Willow Market requires a Stripe TEST secret key')
  if (env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY && !env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY.startsWith('pk_test_')) throw new Error('Willow Market requires a Stripe TEST publishable key')
}

export function demoPaymentConfigured(env: Record<string, string | undefined>) {
  return Boolean(env.STRIPE_SECRET_KEY?.startsWith('sk_test_') && env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY?.startsWith('pk_test_') && env.STRIPE_WEBHOOKS_SIGNING_SECRET?.startsWith('whsec_'))
}

export function paymentErrorCode(message: string): string | undefined {
  try {
    const parsed = JSON.parse(message)
    return typeof parsed?.cause?.code === 'string' ? parsed.cause.code : undefined
  } catch {
    return undefined
  }
}
