-- CPV Demo: актуальная модель данных (под текущую логику кода).
-- Формат комментариев: инлайн, коротко, по каждому полю.

-- posting_mode:
-- auto_with_precheck | автопост по умолчанию, блогер может только перенести/отказаться
-- manual_approval    | сначала "взять в работу", потом автопост в выбранный слот
CREATE TYPE posting_mode AS ENUM (
  'auto_with_precheck',
  'manual_approval'
);

-- offer_status:
-- pending_precheck        | legacy-статус (мигрируется в scheduled)
-- pending_approval        | новый оффер в режиме ручного подтверждения
-- scheduled               | слот согласован, ждём времени публикации
-- rewarded                | публикация выполнена, вознаграждение начислено
-- archived_not_published  | окно кампании завершилось, публикации не было
-- auto_publish_error      | попытка автопоста не удалась
-- declined_by_blogger     | блогер отклонил оффер на этапе принятия решения
-- cancelled_by_blogger    | блогер отменил уже запланированную публикацию
-- cancelled_by_advertiser | рекламодатель отменил оффер
-- expired                 | legacy/служебный терминальный статус
CREATE TYPE offer_status AS ENUM (
  'pending_precheck',
  'pending_approval',
  'scheduled',
  'rewarded',
  'archived_not_published',
  'auto_publish_error',
  'declined_by_blogger',
  'cancelled_by_blogger',
  'cancelled_by_advertiser',
  'expired'
);

-- offer_ui_state:
-- main      | обычная карточка оффера
-- pick_time | экран выбора даты/слота
CREATE TYPE offer_ui_state AS ENUM (
  'main',
  'pick_time'
);

CREATE TABLE bloggers (
  id                     BIGSERIAL PRIMARY KEY,                 -- внутренний ID блогера
  tg_user_id             BIGINT NOT NULL UNIQUE,                -- Telegram user id
  tg_username            TEXT NOT NULL,                         -- username блогера в Telegram
  chat_id                BIGINT,                                -- личный chat_id с ботом
  connected_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),    -- когда блогер подключился
  current_channel_id     BIGINT                                 -- текущий "основной" канал (опционально)
);

CREATE TABLE channels (
  id                     BIGSERIAL PRIMARY KEY,                 -- внутренний ID канала
  blogger_id             BIGINT NOT NULL REFERENCES bloggers(id) ON DELETE CASCADE, -- владелец канала
  tg_chat_id             BIGINT NOT NULL UNIQUE,                -- chat_id Telegram-канала
  title                  TEXT NOT NULL DEFAULT '',              -- название канала
  username               TEXT,                                  -- @username канала (если есть)
  posting_mode           posting_mode NOT NULL DEFAULT 'auto_with_precheck', -- режим публикации
  weekly_post_limit      INTEGER NOT NULL DEFAULT 21 CHECK (weekly_post_limit BETWEEN 1 AND 28), -- лимит постов/нед
  bot_connected          BOOLEAN NOT NULL DEFAULT FALSE,        -- бот добавлен в канал с нужными правами
  bot_member_status      TEXT NOT NULL DEFAULT 'unknown',       -- статус бота в канале (administrator/creator/...)
  auto_paused_until_at   TIMESTAMPTZ,                           -- пауза автопубликаций до этой даты/времени
  auto_pause_message_id  BIGINT,                                -- message_id сообщения о паузе (для reply)
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),    -- когда канал добавили
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()     -- когда канал обновляли
);

CREATE UNIQUE INDEX channels_blogger_username_uidx
  ON channels (blogger_id, username)
  WHERE username IS NOT NULL;

CREATE TABLE channel_schedule_slots (
  channel_id             BIGINT NOT NULL REFERENCES channels(id) ON DELETE CASCADE, -- канал
  day_of_week            SMALLINT NOT NULL CHECK (day_of_week BETWEEN 1 AND 7),     -- 1=Пн ... 7=Вс
  hour_of_day            SMALLINT NOT NULL CHECK (hour_of_day BETWEEN 0 AND 23),     -- час слота (локальное время)
  PRIMARY KEY (channel_id, day_of_week, hour_of_day)
);

CREATE TABLE offers (
  id                     BIGSERIAL PRIMARY KEY,                 -- внутренний ID оффера
  blogger_id             BIGINT NOT NULL REFERENCES bloggers(id) ON DELETE CASCADE, -- блогер-адресат
  channel_id             BIGINT NOT NULL REFERENCES channels(id) ON DELETE CASCADE, -- канал публикации

  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),    -- когда оффер создан
  scheduled_at           TIMESTAMPTZ NOT NULL,                  -- текущий выбранный слот публикации
  availability_from_at   TIMESTAMPTZ NOT NULL,                  -- начало окна кампании
  availability_to_at     TIMESTAMPTZ NOT NULL,                  -- конец окна кампании

  mode_at_creation       posting_mode NOT NULL,                 -- режим канала на момент создания оффера
  status                 offer_status NOT NULL,                 -- текущий статус state machine
  ui_state               offer_ui_state NOT NULL DEFAULT 'main', -- экран в чате (main/pick_time)
  selected_date_page     INTEGER NOT NULL DEFAULT 0,            -- последняя открытая страница дат в picker

  cpv                    INTEGER NOT NULL CHECK (cpv >= 100),   -- ставка CPM/CPV в демо-логике
  estimated_income       INTEGER NOT NULL DEFAULT 0,            -- прогноз дохода блогера

  text_raw               TEXT NOT NULL,                         -- текст рекламы без маркировки
  text_marked            TEXT NOT NULL,                         -- текст с erid-маркером
  erid_tag               TEXT NOT NULL,                         -- erid для поиска/проверки

  decision_deadline_at   TIMESTAMPTZ,                           -- legacy-дедлайн (оставлен для совместимости)
  blogger_decline_reason TEXT,                                  -- причина отказа (если добавите сбор причины)

  ad_message_id          BIGINT,                                -- message_id первичного рекламного текста в личке
  message_id             BIGINT,                                -- message_id карточки оффера в личке
  channel_post_id        BIGINT,                                -- message_id поста в канале после автопоста

  topic_thread_id        BIGINT,                                -- topic id для manual_approval
  topic_closed_at        TIMESTAMPTZ                            -- когда topic был закрыт/удален
);

CREATE INDEX offers_blogger_status_idx ON offers (blogger_id, status);
CREATE INDEX offers_channel_status_idx ON offers (channel_id, status);
CREATE INDEX offers_scheduled_at_idx ON offers (scheduled_at);
CREATE INDEX offers_availability_to_at_idx ON offers (availability_to_at);

ALTER TABLE bloggers
  ADD CONSTRAINT bloggers_current_channel_fk
  FOREIGN KEY (current_channel_id) REFERENCES channels(id) ON DELETE SET NULL;
