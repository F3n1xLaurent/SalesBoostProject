# Стартовый Workflow

## Перед началом любой задачи (каждый раз)

1. Переключиться на `dev` и подтянуть последние изменения:

```bash
git checkout dev
git pull origin dev
```

2. Обновить зависимости (если в `dev` были изменения):

```bash
npm install
```

3. Применить миграции к своей локальной базе:

```bash
npm run prisma:migrate
```

4. Создать свою рабочую ветку от актуального `dev`:

```bash
git checkout -b feature/<task-name>
```

5. (Опционально) пересоздать Prisma client:

```bash
npm run prisma:generate
```

6. Запустить проект:

```bash
npm run dev
```

## Перед созданием PR (синхронизация с dev)

1. Сохранить текущие изменения:

```bash
git add .
git commit -m "wip: ..."
```

2. Подтянуть свежий `dev` и влить его в свою ветку:

```bash
git checkout dev
git pull origin dev
git checkout feature/<task-name>
git merge dev
```

3. Повторно применить миграции (если в `dev` появились новые):

```bash
npm run prisma:migrate
```

4. Проверить запуск и запушить ветку:

```bash
npm run dev
git push origin feature/<task-name>
```

## Общие правила для команды

- Не коммитить `.env`, `prisma/dev.db`, `dist/`.
- Если меняется схема БД: коммитить только `prisma/schema.prisma` и `prisma/migrations/*`.
- Не коммитить локальный файл базы `prisma/dev.db`.
