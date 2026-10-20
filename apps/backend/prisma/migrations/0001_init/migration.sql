-- CreateTable
CREATE TABLE "node_group" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "token" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "port_range" TEXT,
    "connect_ip" TEXT,
    "node_type" TEXT NOT NULL,
    "load_balance_type" TEXT NOT NULL DEFAULT 'round',
    "allow_listen_protocol" BOOLEAN NOT NULL DEFAULT false,
    "allow_listen_protocols" JSONB,
    "allow_tunnel_types" JSONB,
    "bypass_type" TEXT NOT NULL DEFAULT 'blacklist',
    "bypass_list" JSONB,
    "admission" BOOLEAN NOT NULL DEFAULT false,
    "block_protocols" JSONB,
    "traffic_rate" REAL NOT NULL DEFAULT 1,
    "need_out_node_group" BOOLEAN NOT NULL DEFAULT true,
    "allow_out_node_groups" JSONB,
    "allow_in_node_groups" JSONB,
    "order_by" REAL NOT NULL DEFAULT 1000,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    "user_id" INTEGER NOT NULL,
    CONSTRAINT "node_group_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "node" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "weight" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'active',
    "node_id" TEXT NOT NULL,
    "connect_ip" TEXT NOT NULL,
    "version" TEXT NOT NULL DEFAULT 'unknown',
    "backup" BOOLEAN NOT NULL DEFAULT false,
    "order_by" REAL NOT NULL DEFAULT 1000,
    "custom_line" TEXT,
    "dns_status" BOOLEAN NOT NULL DEFAULT false,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    "node_group_id" INTEGER NOT NULL,
    CONSTRAINT "node_node_group_id_fkey" FOREIGN KEY ("node_group_id") REFERENCES "node_group" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "tunnel" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "name" TEXT NOT NULL,
    "tunnel_type" TEXT NOT NULL DEFAULT 'wss',
    "category" TEXT NOT NULL DEFAULT 'port_forward',
    "listen_ip" TEXT,
    "listen_port" INTEGER,
    "listen_protocol" JSONB,
    "port_conflict_at" DATETIME,
    "status" TEXT NOT NULL DEFAULT 'active',
    "forward_addresses" JSONB NOT NULL,
    "forward_addresses_protocol" JSONB,
    "load_balance_type" TEXT NOT NULL,
    "ip_type" TEXT NOT NULL DEFAULT 'ipv4',
    "order_by" REAL NOT NULL DEFAULT 1000,
    "ip_limit" INTEGER,
    "client_limit" INTEGER,
    "bandwidth_limit" INTEGER,
    "traffic" REAL NOT NULL DEFAULT 0,
    "traffic_cost" REAL NOT NULL DEFAULT 0,
    "proxy_protocol" BOOLEAN NOT NULL DEFAULT false,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    "in_node_group_id" INTEGER NOT NULL,
    "out_node_group_id" INTEGER,
    "user_id" INTEGER NOT NULL,
    CONSTRAINT "tunnel_in_node_group_id_fkey" FOREIGN KEY ("in_node_group_id") REFERENCES "node_group" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "tunnel_out_node_group_id_fkey" FOREIGN KEY ("out_node_group_id") REFERENCES "node_group" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "tunnel_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "tunnel_chain" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "tunnel_id" INTEGER NOT NULL,
    "node_type" TEXT NOT NULL,
    "node_group_id" INTEGER NOT NULL,
    CONSTRAINT "tunnel_chain_tunnel_id_fkey" FOREIGN KEY ("tunnel_id") REFERENCES "tunnel" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "tunnel_chain_node_group_id_fkey" FOREIGN KEY ("node_group_id") REFERENCES "node_group" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "user" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "super_admin" BOOLEAN NOT NULL DEFAULT false,
    "email" TEXT NOT NULL,
    "balance" REAL NOT NULL DEFAULT 0,
    "commission_balance" REAL NOT NULL DEFAULT 0,
    "tg_id" TEXT,
    "uid" TEXT,
    "note" TEXT,
    "parent_id" INTEGER,
    "referral_commission_rate" REAL,
    "referral_first_only" BOOLEAN,
    "auto_renew" BOOLEAN NOT NULL DEFAULT false,
    "api_key" TEXT NOT NULL,
    "subscription_key" TEXT NOT NULL,
    "notify_subscriptions" JSONB,
    "admin_notify_subscriptions" JSONB,
    "status" TEXT NOT NULL DEFAULT 'active',
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "user_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "user" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "local_credential" (
    "user_id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "password_hash" TEXT NOT NULL,
    "email_verified" BOOLEAN NOT NULL DEFAULT false,
    "verification_token_hash" TEXT,
    "verification_token_expires_at" DATETIME,
    "verification_sent_at" DATETIME,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "local_credential_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "admin_role" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "permissions" JSONB NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "user_plan" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "user_id" INTEGER NOT NULL,
    "traffic" REAL,
    "traffic_used" REAL NOT NULL DEFAULT 0,
    "max_tunnels" INTEGER,
    "whitelist_ips" JSONB,
    "expired_at" DATETIME,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    "plan_id" INTEGER NOT NULL,
    CONSTRAINT "user_plan_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "user_plan_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "plan" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "plan" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "original_price" REAL,
    "price" REAL NOT NULL,
    "max_tunnels" INTEGER,
    "traffic" INTEGER,
    "ip_limit" INTEGER,
    "client_limit" INTEGER,
    "bandwidth_limit" INTEGER,
    "whitelist_limit" INTEGER,
    "allow_custom_in_node_group" BOOLEAN NOT NULL,
    "allow_custom_out_node_group" BOOLEAN NOT NULL,
    "all_in_node_groups" BOOLEAN NOT NULL,
    "all_out_node_groups" BOOLEAN NOT NULL,
    "setup_fee" REAL,
    "billing_cycle" TEXT NOT NULL DEFAULT 'month',
    "status" TEXT NOT NULL DEFAULT 'active',
    "renewable" BOOLEAN NOT NULL DEFAULT true,
    "stock" INTEGER,
    "order_by" REAL NOT NULL DEFAULT 1000,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "plan_node_group" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "plan_id" INTEGER NOT NULL,
    "node_group_id" INTEGER NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "plan_node_group_node_group_id_fkey" FOREIGN KEY ("node_group_id") REFERENCES "node_group" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "plan_node_group_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "plan" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "plan_order" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "user_id" INTEGER NOT NULL,
    "plan_id" INTEGER NOT NULL,
    "price" REAL NOT NULL,
    "balance" REAL NOT NULL,
    "coupon_id" INTEGER,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "plan_order_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "plan_order_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "plan" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "plan_order_coupon_id_fkey" FOREIGN KEY ("coupon_id") REFERENCES "plan_coupon" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "topup_order" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "user_id" INTEGER NOT NULL,
    "price" REAL NOT NULL,
    "balance" REAL NOT NULL DEFAULT 0,
    "bonus" REAL NOT NULL DEFAULT 0,
    "payment_id" INTEGER NOT NULL,
    "pay_url" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "order_id" TEXT NOT NULL,
    "trade_id" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "topup_order_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "topup_order_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "payment" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "topup_activity" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "type" TEXT NOT NULL,
    "value" REAL NOT NULL,
    "min_amount" REAL,
    "max_amount" REAL,
    "valid_start" DATETIME,
    "valid_end" DATETIME,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "tunnel_traffic" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "tunnel_id" INTEGER NOT NULL,
    "traffic" REAL NOT NULL,
    "traffic_cost" REAL NOT NULL,
    "date" DATETIME NOT NULL,
    CONSTRAINT "tunnel_traffic_tunnel_id_fkey" FOREIGN KEY ("tunnel_id") REFERENCES "tunnel" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "config" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "name" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "payment" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "fixed_fee" REAL,
    "percent_fee" REAL,
    "name" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "config" JSONB NOT NULL,
    "method" TEXT NOT NULL,
    "type" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "order_by" REAL NOT NULL DEFAULT 1000,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "plan_coupon" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "code" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "valid_cycle" TEXT,
    "value" REAL NOT NULL,
    "valid_start" DATETIME,
    "valid_end" DATETIME,
    "max_use" INTEGER,
    "max_use_per_user" INTEGER,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "balance_log" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "user_id" INTEGER NOT NULL,
    "balance" REAL NOT NULL,
    "amount" REAL NOT NULL,
    "type" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "balance_log_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "commission_log" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "user_id" INTEGER NOT NULL,
    "balance" REAL NOT NULL,
    "amount" REAL NOT NULL,
    "type" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "commission_log_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "withdraw_request" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "user_id" INTEGER NOT NULL,
    "amount" REAL NOT NULL,
    "method" TEXT NOT NULL,
    "account" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "remark" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "withdraw_request_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ticket" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "user_id" INTEGER NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "ticket_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ticket_reply" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "content" TEXT NOT NULL,
    "is_admin" BOOLEAN NOT NULL DEFAULT false,
    "ticket_id" INTEGER NOT NULL,
    "user_id" INTEGER NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "ticket_reply_ticket_id_fkey" FOREIGN KEY ("ticket_id") REFERENCES "ticket" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "ticket_reply_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "in_node_group_dns" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "in_node_group_id" INTEGER NOT NULL,
    "dns_provider_id" INTEGER NOT NULL,
    "ttl" INTEGER NOT NULL DEFAULT 60,
    "ipv6" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'active',
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "in_node_group_dns_in_node_group_id_fkey" FOREIGN KEY ("in_node_group_id") REFERENCES "node_group" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "in_node_group_dns_dns_provider_id_fkey" FOREIGN KEY ("dns_provider_id") REFERENCES "dns_provider" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "dns_provider" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "config" JSONB NOT NULL,
    "user_id" INTEGER NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "dns_provider_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "_AdminRoleToUser" (
    "A" INTEGER NOT NULL,
    "B" INTEGER NOT NULL,
    CONSTRAINT "_AdminRoleToUser_A_fkey" FOREIGN KEY ("A") REFERENCES "admin_role" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "_AdminRoleToUser_B_fkey" FOREIGN KEY ("B") REFERENCES "user" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "node_group_token_key" ON "node_group"("token");

-- CreateIndex
CREATE UNIQUE INDEX "node_node_id_key" ON "node"("node_id");

-- CreateIndex
CREATE UNIQUE INDEX "tunnel_listen_port_in_node_group_id_key" ON "tunnel"("listen_port", "in_node_group_id");

-- CreateIndex
CREATE UNIQUE INDEX "user_email_key" ON "user"("email");

-- CreateIndex
CREATE UNIQUE INDEX "user_api_key_key" ON "user"("api_key");

-- CreateIndex
CREATE UNIQUE INDEX "user_subscription_key_key" ON "user"("subscription_key");

-- CreateIndex
CREATE UNIQUE INDEX "admin_role_name_key" ON "admin_role"("name");

-- CreateIndex
CREATE UNIQUE INDEX "user_plan_user_id_key" ON "user_plan"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "topup_order_order_id_key" ON "topup_order"("order_id");

-- CreateIndex
CREATE UNIQUE INDEX "topup_order_trade_id_key" ON "topup_order"("trade_id");

-- CreateIndex
CREATE INDEX "tunnel_traffic_date_idx" ON "tunnel_traffic"("date");

-- CreateIndex
CREATE UNIQUE INDEX "config_name_key" ON "config"("name");

-- CreateIndex
CREATE UNIQUE INDEX "_AdminRoleToUser_AB_unique" ON "_AdminRoleToUser"("A", "B");

-- CreateIndex
CREATE INDEX "_AdminRoleToUser_B_index" ON "_AdminRoleToUser"("B");

