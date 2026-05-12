export type MockHoldingSeed = {
  key: string;
  code: string;
  name: string;
  type?: 'own' | 'franchised';
  isActive?: boolean;
};

export type MockDealershipSeed = {
  code: string;
  name: string;
  city: string;
  address: string;
  holdingKey?: string | null;
  isActive?: boolean;
};

export const MOCK_HOLDING_SEEDS: MockHoldingSeed[] = [
  { key: 'north', code: 'north-group', name: 'АвтоХолдинг Север', type: 'own' },
  { key: 'drive', code: 'drive-group', name: 'Drive Group', type: 'own' },
  { key: 'motor', code: 'motor-service', name: 'МоторСервис', type: 'own' },
  { key: 'auto-plus', code: 'auto-plus', name: 'Авто Плюс', type: 'own' },
  { key: 'cardealer', code: 'car-dealer', name: 'КарДилер', type: 'own' },
];

export const MOCK_DEALERSHIP_SEEDS: MockDealershipSeed[] = [
  { code: 'd01-central', name: 'Центральный', city: 'Москва', address: 'Москва, Ленинградский проспект, 36', holdingKey: 'north' },
  { code: 'd02-sever', name: 'Север', city: 'Москва', address: 'Москва, Дмитровское шоссе, 98', holdingKey: 'north' },
  { code: 'd03-south', name: 'Юг', city: 'Москва', address: 'Москва, Варшавское шоссе, 142', holdingKey: 'drive' },
  { code: 'd04-west', name: 'Запад', city: 'Москва', address: 'Москва, Можайское шоссе, 54', holdingKey: 'drive' },
  { code: 'd05-east', name: 'Восток', city: 'Москва', address: 'Москва, Щелковское шоссе, 70', holdingKey: null },
  { code: 'd06-premium', name: 'Премиум', city: 'Санкт-Петербург', address: 'Санкт-Петербург, Пулковское шоссе, 14', holdingKey: 'motor' },
  { code: 'd07-nevsky', name: 'Невский', city: 'Санкт-Петербург', address: 'Санкт-Петербург, проспект Обуховской Обороны, 120', holdingKey: 'motor' },
  { code: 'd08-baltika', name: 'Балтика', city: 'Санкт-Петербург', address: 'Санкт-Петербург, Приморский проспект, 72', holdingKey: 'auto-plus' },
  { code: 'd09-neva', name: 'Нева', city: 'Санкт-Петербург', address: 'Санкт-Петербург, Софийская улица, 8', holdingKey: null },
  { code: 'd10-kazan-auto', name: 'Казань Авто', city: 'Казань', address: 'Казань, Проспект Победы, 141', holdingKey: 'cardealer' },
  { code: 'd11-volga', name: 'Волга', city: 'Казань', address: 'Казань, Горьковское шоссе, 28', holdingKey: 'cardealer' },
  { code: 'd12-tatarstan', name: 'Татарстан', city: 'Казань', address: 'Казань, Оренбургский тракт, 17', holdingKey: null },
  { code: 'd13-ural', name: 'Урал', city: 'Екатеринбург', address: 'Екатеринбург, улица Металлургов, 65', holdingKey: 'auto-plus' },
  { code: 'd14-gorny', name: 'Горный', city: 'Екатеринбург', address: 'Екатеринбург, Сибирский тракт, 12', holdingKey: 'auto-plus' },
  { code: 'd15-zvezda', name: 'Звезда', city: 'Екатеринбург', address: 'Екатеринбург, Кольцовский тракт, 3', holdingKey: null },
];
