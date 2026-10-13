export function assertDemoStripeKeys(env: Record<string, string | undefined>) {
  if (env.STRIPE_SECRET_KEY && !env.STRIPE_SECRET_KEY.startsWith('sk_test_')) throw new Error('Willow Market requires a Stripe TEST secret key')
  if (env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY && !env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY.startsWith('pk_test_')) throw new Error('Willow Market requires a Stripe TEST publishable key')
}
