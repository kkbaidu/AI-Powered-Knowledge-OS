import { uuid, integer, pgTable, varchar, text} from "drizzle-orm/pg-core";

export const usersTable = pgTable("users", {
  id: uuid("id").defaultRandom().primaryKey(),
  fName: varchar({ length: 255 }).notNull(),
  lName: varchar({ length: 255 }).notNull(),
  age: integer().notNull(),
  email: varchar({ length: 255 }).notNull().unique(),
  passward: text("password").notNull(),
});
