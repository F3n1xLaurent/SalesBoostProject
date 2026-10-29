import { normalizeConversationText } from './realtimeConversationFlow';

type VehicleBrand = { id: string; label: string; stems: string[] };

const VEHICLE_BRANDS: VehicleBrand[] = [
  { id: 'mercedes', label: 'Мерседес-Бенц', stems: ['мерседес', 'mercedes'] },
  { id: 'haval', label: 'Хавейл', stems: ['хавейл', 'хавал', 'haval'] },
  { id: 'bmw', label: 'БМВ', stems: ['бмв', 'bmw'] },
  { id: 'audi', label: 'Ауди', stems: ['ауди', 'audi'] },
  { id: 'volkswagen', label: 'Фольксваген', stems: ['фольксваген', 'volkswagen'] },
  { id: 'toyota', label: 'Тойота', stems: ['тойот', 'toyota'] },
  { id: 'lexus', label: 'Лексус', stems: ['лексус', 'lexus'] },
  { id: 'kia', label: 'Киа', stems: ['киа', 'kia'] },
  { id: 'hyundai', label: 'Хёндэ', stems: ['хенда', 'хендэ', 'хёнд', 'hyundai'] },
  { id: 'geely', label: 'Джили', stems: ['джили', 'geely'] },
  { id: 'chery', label: 'Чери', stems: ['чери', 'chery'] },
  { id: 'exeed', label: 'Эксид', stems: ['эксид', 'exeed'] },
  { id: 'omoda', label: 'Омода', stems: ['омод', 'omoda'] },
  { id: 'changan', label: 'Чанган', stems: ['чанган', 'changan'] },
  { id: 'tank', label: 'Танк', stems: ['танк', 'tank'] },
  { id: 'lada', label: 'Лада', stems: ['лад', 'lada'] },
  { id: 'skoda', label: 'Шкода', stems: ['шкод', 'skoda'] },
  { id: 'porsche', label: 'Порше', stems: ['порше', 'porsche'] },
  { id: 'land-rover', label: 'Ленд Ровер', stems: ['ленд ровер', 'land rover'] },
  { id: 'volvo', label: 'Вольво', stems: ['вольво', 'volvo'] },
  { id: 'nissan', label: 'Ниссан', stems: ['ниссан', 'nissan'] },
  { id: 'mazda', label: 'Мазда', stems: ['мазд', 'mazda'] },
  { id: 'mitsubishi', label: 'Мицубиси', stems: ['мицубис', 'mitsubishi'] },
  { id: 'honda', label: 'Хонда', stems: ['хонд', 'honda'] },
  { id: 'renault', label: 'Рено', stems: ['рено', 'renault'] },
  { id: 'ford', label: 'Форд', stems: ['форд', 'ford'] },
  { id: 'gac', label: 'ГАК', stems: ['гак', 'gac'] },
  { id: 'zeekr', label: 'Зикр', stems: ['зикр', 'zeekr'] },
];

function mentionsBrand(text: string, brand: VehicleBrand): boolean {
  const normalized = normalizeConversationText(text);
  const tokens = normalized.split(' ').filter(Boolean);
  return brand.stems.some((stem) => stem.includes(' ')
    ? normalized.includes(stem)
    : tokens.some((token) => token === stem || token.startsWith(stem)));
}

export type VehicleEntityMismatch = {
  targetBrand: string;
  mentionedBrand: string;
  targetSubject: string;
};

export function detectVehicleEntityMismatch(
  targetSubject: string,
  managerText: string,
): VehicleEntityMismatch | null {
  const target = VEHICLE_BRANDS.find((brand) => mentionsBrand(targetSubject, brand));
  if (!target) return null;
  const mentioned = VEHICLE_BRANDS.find((brand) => brand.id !== target.id && mentionsBrand(managerText, brand));
  if (!mentioned) return null;
  return {
    targetBrand: target.label,
    mentionedBrand: mentioned.label,
    targetSubject: targetSubject.trim().slice(0, 240),
  };
}

export function vehicleMismatchInstruction(mismatch: VehicleEntityMismatch): string {
  return `КРИТИЧЕСКАЯ ПРОВЕРКА ОБЪЕКТА: разговор идёт о «${mismatch.targetSubject}» `
    + `(марка ${mismatch.targetBrand}), но сотрудник только что назвал другую марку — ${mismatch.mentionedBrand}. `
    + 'Не переноси сообщённые после этого характеристики, числа, пробег, цену или состояние на целевой автомобиль. '
    + `В следующей реплике коротко и спокойно уточни, что речь идёт именно о ${mismatch.targetBrand}, `
    + 'и попроси назвать характеристику для целевого автомобиля. Это обязательное уточнение и исключение из правила принимать ответ не по теме.';
}
