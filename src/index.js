import pkg from "pg";
import NodeCache from "node-cache";

const { Pool } = pkg;
const cache = new NodeCache({ stdTTL: 0 });

export default async function usePostgresAuthState(
	connOptions,
	phoneNumber,
	{ proto, initAuthCreds, BufferJSON }
) {
	if (!connOptions || typeof connOptions !== "object") throw new Error("Invalid connection options.");
	if (!phoneNumber || typeof phoneNumber !== "string") throw new Error("phoneNumber must be a string.");
	if (!proto || !initAuthCreds || !BufferJSON) throw new Error("Missing required dependencies.");

	const pool = new Pool(connOptions);

	await pool.query(`
        CREATE TABLE IF NOT EXISTS auth_state (
            id SERIAL PRIMARY KEY,
            phone_number BIGINT NOT NULL,
            key TEXT NOT NULL,
            value JSONB, 
            UNIQUE (phone_number, key)
        )
    `);

	const dbSet = async (key, value) => {
		const phoneNum = BigInt(phoneNumber);
		const json = JSON.stringify(value, BufferJSON.replacer);

		try {
			await pool.query(
				`INSERT INTO auth_state (phone_number, key, value)
                 VALUES ($1, $2, $3)
                 ON CONFLICT (phone_number, key)
                 DO UPDATE SET value = EXCLUDED.value`,
				[phoneNum, key, json]
			);
			cache.set(`${phoneNumber}:${key}`, value);
		} catch (err) {
			console.error(`Error setting auth for ${phoneNumber}:${key}:`, err);
			throw err;
		}
	};

	const dbGet = async (key) => {
		const cacheKey = `${phoneNumber}:${key}`;
		const cached = cache.get(cacheKey);
		if (cached !== undefined) return cached;

		const phoneNum = BigInt(phoneNumber);
		try {
			const res = await pool.query(
				`SELECT value::TEXT FROM auth_state WHERE phone_number = $1 AND key = $2 LIMIT 1`,
				[phoneNum, key]
			);

			if (res.rowCount === 0) return null;

			const parsed = JSON.parse(res.rows[0].value, BufferJSON.reviver);
			cache.set(cacheKey, parsed);
			return parsed;
		} catch (err) {
			console.error(`Error getting auth for ${phoneNumber}:${key}:`, err);
			return null;
		}
	};

	const dbDelete = async (key) => {
		const phoneNum = BigInt(phoneNumber);
		try {
			await pool.query(
				`DELETE FROM auth_state WHERE phone_number = $1 AND key = $2`,
				[phoneNum, key]
			);
			cache.del(`${phoneNumber}:${key}`);
		} catch (err) {
			console.error(`Error deleting auth for ${phoneNumber}:${key}:`, err);
		}
	};

	const dbClearByPhone = async () => {
		const phoneNum = BigInt(phoneNumber);
		try {
			await pool.query(`DELETE FROM auth_state WHERE phone_number = $1`, [phoneNum]);
			cache.keys().forEach((k) => k.startsWith(`${phoneNumber}:`) && cache.del(k));
		} catch (err) {
			console.error(`Error clearing auth for ${phoneNumber}:`, err);
		}
	};

	const creds = (await dbGet("creds")) ?? initAuthCreds();
	if (!cache.has(`${phoneNumber}:creds`)) {
        await dbSet("creds", creds);
    }

	return {
		state: {
			creds,
			keys: {
				get: async (type, ids) => {
					const out = {};
					await Promise.all(
						ids.map(async (id) => {
							const keyName = `${type}-${id}`;
							let value = await dbGet(keyName);
							if (type === "app-state-sync-key" && value) {
								value = proto.Message.AppStateSyncKeyData.fromObject(value);
							}
							out[id] = value || null;
						})
					);
					return out;
				},
				set: async (data) => {
					const ops = [];
					for (const category in data) {
						for (const id in data[category]) {
							const value = data[category][id];
							const keyName = `${category}-${id}`;
							if (value) ops.push(dbSet(keyName, value));
							else ops.push(dbDelete(keyName));
						}
					}
					await Promise.all(ops);
				}
			}
		},
		saveCreds: async () => await dbSet("creds", creds),
		resetSession: async () => await dbClearByPhone()
	};
}
