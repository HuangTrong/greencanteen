export const POINTS_PER_CHECKIN = 10;
export const PLASTIC_GRAMS_PER_CUP = 12;
export const CO2_GRAMS_PER_CUP = 8;
export const TREES_SYMBOLIC_DIVISOR = 50;

export function computeBadges(totalCheckIns, ecoPoints) {
  const badges = [];
  if (totalCheckIns >= 1) badges.push('first_sip');
  if (totalCheckIns >= 5) badges.push('green_starter');
  if (totalCheckIns >= 20) badges.push('eco_warrior');
  if (totalCheckIns >= 50) badges.push('planet_guardian');
  if (ecoPoints >= 100) badges.push('century_points');
  return badges;
}

export const BADGE_LABELS = {
  first_sip: 'Ngụm đầu tiên xanh',
  green_starter: 'Khởi động xanh',
  eco_warrior: 'Chiến binh sinh thái',
  planet_guardian: 'Người bảo vệ hành tinh',
  century_points: '100 điểm sinh thái',
};
