import { expect, test } from '@playwright/test';
import ExcelJS from 'exceljs';
import { login } from './helpers';

const HEAD = ['firstName', 'lastName', 'dateOfBirth', 'email', 'primaryHotelId', 'primaryDepartmentId', 'hotelIds', 'departmentIds', 'contractStartDate', 'contractEndDate', 'employmentType', 'workingModel', 'workDaysPerWeek', 'workingWeekdays', 'targetHoursPerWeek', 'targetHoursPerMonth', 'vacationDaysPerYear'];

test('Excel import: template, dry run with an error, confirm, one-time credentials sheet', async ({ page }) => {
  await login(page, 'admin@demo.test', { totp: true, role: /Administration/ });
  await page.goto('/staff/import');

  const [tpl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Vorlage herunterladen' }).click()]);
  expect(tpl.suggestedFilename()).toBe('mitarbeiter-import-vorlage.xlsx');

  // hotel and department ids come from the "Hinweise" sheet of the template
  const path = await tpl.path();
  const tw = new ExcelJS.Workbook();
  await tw.xlsx.readFile(path!);
  const hint: any[][] = [];
  tw.getWorksheet('Hinweise')!.eachRow((r) => hint.push((r.values as any[]).slice(1)));
  const hotelRow = hint.find((r) => r[1] === 'Frankfurt' || String(r[1]).includes('Frankfurt'))!;
  const hotelId = Number(hotelRow[0]);
  const deptRow = hint[hint.indexOf(hotelRow) + 1]!;
  const deptId = Number(deptRow[2]);

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Mitarbeiter');
  ws.addRow(HEAD);
  const row = (first: string, over: Record<string, unknown> = {}) => {
    const v: Record<string, unknown> = { firstName: first, lastName: 'Importiert', dateOfBirth: '1992-04-05', email: '', primaryHotelId: hotelId, primaryDepartmentId: deptId, contractStartDate: '2026-01-01', employmentType: 'full_time', workingModel: 'salary', workDaysPerWeek: 5, targetHoursPerWeek: 40, vacationDaysPerYear: 30, ...over };
    ws.addRow(HEAD.map((h) => v[h] ?? null));
  };
  row('Importa');
  row('Importo', { email: 'importo@demo.test' });
  row('Kaputt', { dateOfBirth: 'gestern' });
  const buf = Buffer.from(await wb.xlsx.writeBuffer());

  await page.setInputFiles('#imp-file', { name: 'neue-mitarbeiter.xlsx', mimeType: 'application/octet-stream', buffer: buf });
  await page.getByTestId('import-dry').click();
  const result = page.getByTestId('import-result');
  await expect(result).toContainText('Ergebnis des Probelaufs');
  await expect(page.getByTestId('import-problem')).toHaveCount(1);
  await expect(page.getByTestId('import-problem')).toContainText('dateOfBirth');
  await expect(page.getByTestId('import-confirm')).toContainText('(2)');

  await page.getByTestId('import-confirm').click();
  await expect(result).toContainText('Import abgeschlossen');
  const [errors] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Fehler als CSV' }).click()]);
  expect(errors.suggestedFilename()).toMatch(/fehler\.csv$/);
  const [slips] = await Promise.all([page.waitForEvent('download'), page.getByTestId('import-credentials').click()]);
  expect(slips.suggestedFilename()).toMatch(/^zugangsdaten-import-\d+\.pdf$/);
  // downloadable once: the button is gone afterwards
  await expect(page.getByTestId('import-credentials')).toHaveCount(0);

  await page.goto('/staff');
  await expect(page.getByText(/Importa/).first()).toBeVisible();
});
