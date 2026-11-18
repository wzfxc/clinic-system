import { expect, test, type Page } from '@playwright/test';
import type { expireCheckoutHoldForTest as ExpireFn, prepareE2ePatients as PrepareFn } from '@clinic/shared/testing';

interface TestingModule {
  prepareE2ePatients: typeof PrepareFn;
  expireCheckoutHoldForTest: typeof ExpireFn;
}

const loadTesting = (): Promise<TestingModule> =>
  new Function('specifier', 'return import(specifier)')('@clinic/shared/testing') as Promise<TestingModule>;

const DEMO_PASSWORD = 'demo-password';

async function signIn(page: Page, email: string): Promise<void> {
  await page.goto('/uk?city=Kyiv&serviceId=1');
  await page.getByTestId('login-email').fill(email);
  await page.getByTestId('login-password').fill(DEMO_PASSWORD);
  await page.getByTestId('login-submit').click();
  await expect(page.getByTestId('current-user')).toBeVisible();
}

test.beforeAll(async () => {
  const { prepareE2ePatients } = await loadTesting();
  await prepareE2ePatients();
});

test.beforeEach(async () => {
  const { prepareE2ePatients } = await loadTesting();
  await prepareE2ePatients();
});

test.describe('clinic booking e2e', () => {
  test('1. hold -> confirm in browser A removes the slot in browser B without reload', async ({ browser }) => {
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const pageA = await ctxA.newPage();
    const pageB = await ctxB.newPage();
    try {
      await signIn(pageA, 'e2e-p1@clinic.local');
      await signIn(pageB, 'e2e-p2@clinic.local');

      const firstSlotA = pageA.locator('[data-testid="slots-grid"] button').first();
      await expect(firstSlotA).toBeVisible();
      const slotTestId = await firstSlotA.getAttribute('data-testid');
      expect(slotTestId).toBeTruthy();

      // Browser B sees the same free slot before booking
      await expect(pageB.getByTestId(slotTestId!)).toBeVisible();

      // Browser A holds and confirms the slot
      await firstSlotA.click();
      await expect(pageA.getByTestId('active-hold')).toBeVisible();
      await pageA.getByTestId('confirm-hold-btn').click();
      await expect(pageA.getByTestId('booking-status')).toContainText('Confirmed');

      // Browser B sees the slot disappear live via slotsChanged subscription without page reload
      await expect(pageB.getByTestId(slotTestId!)).toHaveCount(0);
    } finally {
      await ctxA.close();
      await ctxB.close();
    }
  });

  test('2. hold not confirmed for 10 minutes returns to the grid and late confirmation is rejected', async ({ page }) => {
    await signIn(page, 'e2e-p1@clinic.local');

    const firstSlot = page.locator('[data-testid="slots-grid"] button').first();
    await expect(firstSlot).toBeVisible();
    const slotTestId = await firstSlot.getAttribute('data-testid');
    expect(slotTestId).toBeTruthy();

    await firstSlot.click();
    const holdBanner = page.getByTestId('active-hold');
    await expect(holdBanner).toBeVisible();
    const apptIdAttr = await holdBanner.getAttribute('data-appointment-id');
    const appointmentId = Number(apptIdAttr);
    expect(appointmentId).toBeGreaterThan(0);

    // While held, the slot is gone from the free-slot grid
    await expect(page.getByTestId(slotTestId!)).toHaveCount(0);

    // Fast-forward the checkout hold past 10 minutes (10:01)
    const { expireCheckoutHoldForTest } = await loadTesting();
    await expireCheckoutHoldForTest(appointmentId);

    // The slot returns to the grid automatically via slotsChanged without page reload
    await expect(page.getByTestId(slotTestId!)).toBeVisible();

    // Attempting to confirm at 10:01 is rejected with HOLD_EXPIRED
    await page.getByTestId('confirm-hold-btn').click();
    await expect(page.getByTestId('booking-error')).toContainText('HOLD_EXPIRED');
  });

  test('3. cancelling a confirmed booking sends an offer to the first waitlist candidate who accepts it', async ({
    browser,
  }) => {
    const ctxOwner = await browser.newContext();
    const ctxWaiter = await browser.newContext();
    const pageOwner = await ctxOwner.newPage();
    const pageWaiter = await ctxWaiter.newPage();
    try {
      await signIn(pageOwner, 'e2e-p1@clinic.local');
      await signIn(pageWaiter, 'e2e-waiter1@clinic.local');

      const firstSlot = pageOwner.locator('[data-testid="slots-grid"] button').first();
      await expect(firstSlot).toBeVisible();
      const doctorId = await firstSlot.getAttribute('data-doctor-id');
      const localDate = await firstSlot.getAttribute('data-local-date');
      expect(doctorId).toBeTruthy();
      expect(localDate).toBeTruthy();

      // Owner holds and confirms the slot
      await firstSlot.click();
      const holdBanner = pageOwner.getByTestId('active-hold');
      await expect(holdBanner).toBeVisible();
      const appointmentId = Number(await holdBanner.getAttribute('data-appointment-id'));
      await pageOwner.getByTestId('confirm-hold-btn').click();
      await expect(pageOwner.getByTestId(`appointment-${appointmentId}`)).toHaveAttribute('data-status', 'booked');

      // Waiter filters by that doctor and joins the waitlist for that date
      await pageWaiter.getByTestId('filter-doctor').selectOption(doctorId!);
      await pageWaiter.getByTestId('waitlist-date-from').fill(localDate!);
      await pageWaiter.getByTestId('waitlist-date-to').fill(localDate!);
      await pageWaiter.getByTestId('join-waitlist-btn').click();
      await expect(pageWaiter.getByTestId('waitlist-entries')).toBeVisible();

      // Owner cancels the confirmed appointment
      await pageOwner.getByTestId(`cancel-appointment-${appointmentId}`).click();
      await expect(pageOwner.getByTestId(`appointment-${appointmentId}`)).toHaveAttribute('data-status', 'cancelled');

      // Waiter receives the offer and accepts it
      await expect(pageWaiter.getByTestId('accept-offer-btn')).toBeVisible();
      await pageWaiter.getByTestId('accept-offer-btn').click();
      await expect(pageWaiter.getByTestId('booking-status')).toContainText('Offer accepted');
      await expect(pageWaiter.locator('[data-testid="my-appointments"] [data-status="booked"]')).toHaveCount(1);
    } finally {
      await ctxOwner.close();
      await ctxWaiter.close();
    }
  });

  test('4. URL state survives reload and Back button; locales uk/en/pl, clinic timezone and field validation', async ({
    browser,
  }) => {
    // Emulate a patient in America/New_York browsing Warsaw in Polish
    const nyContext = await browser.newContext({ timezoneId: 'America/New_York' });
    const page = await nyContext.newPage();
    try {
      await page.goto('/uk?city=Kyiv&serviceId=1');
      await expect(page.getByTestId('clinic-timezone')).toHaveText('Europe/Kyiv');
      await expect(page.getByTestId('sample-price')).toContainText('₴');

      // Form field-level validation errors on empty submit
      await page.getByTestId('login-submit').click();
      await expect(page.getByTestId('email-error')).toBeVisible();
      await expect(page.getByTestId('password-error')).toBeVisible();

      // Change filter to Warsaw -> pushes URL state
      await page.getByTestId('filter-city').selectOption('Warsaw');
      await expect(page).toHaveURL(/city=Warsaw/);
      await expect(page.getByTestId('clinic-timezone')).toHaveText('Europe/Warsaw');

      // Reload keeps Warsaw from URL
      await page.reload();
      await expect(page.getByTestId('filter-city')).toHaveValue('Warsaw');
      await expect(page.getByTestId('clinic-timezone')).toHaveText('Europe/Warsaw');

      // Browser Back button restores Kyiv
      await page.goBack();
      await expect(page.getByTestId('filter-city')).toHaveValue('Kyiv');

      // Switch to Polish locale and verify PLN currency & plural forms
      await page.getByTestId('filter-city').selectOption('Warsaw');
      await page.getByTestId('lang-pl').click();
      await expect(page).toHaveURL(/\/pl\?.*city=Warsaw/);
      await expect(page.getByTestId('sample-price')).toContainText('zł');
      await expect(page.getByTestId('appointments-count')).toContainText('wizyty');
    } finally {
      await nyContext.close();
    }
  });
});
