// analysis-service/db.js
//
// Postgres runs in Docker as "atm-postgres". The host port varies by
// environment: locally it's mapped to 5433 (5432 was already taken by
// another container), on the AWS EC2 deployment it's the default 5432.
// Rather than hardcoding one or the other, the port is read from
// PG_PORT in .env, with 5433 as the local-development default so
// nothing breaks if it's left unset.
//
// Mongo uses Atlas — connection string loaded from .env, never hardcoded.
//
// Both pools are explicitly sized (rather than left at library
// defaults) following the week 6 load-testing investigation: default
// pool sizes were suspected contributors to response time under load,
// tested directly, and this reflects the settings used for that test.

require("dotenv").config();

const { Pool } = require("pg");
const { MongoClient } = require("mongodb");

// --- Postgres (Docker, "atm-postgres" container) ---------------------------

const pgPool = new Pool({
  host: "localhost",
  port: process.env.PG_PORT ? parseInt(process.env.PG_PORT, 10) : 5433,
  user: "postgres",
  password: "devpassword",
  database: "postgres",
  max: 30,
});

// --- MongoDB (Atlas) ------------------------------------------------------

if (!process.env.MONGO_URI) {
  throw new Error(
    "MONGO_URI is not set. Add it to analysis-service/.env — see .env.example."
  );
}

const mongoClient = new MongoClient(process.env.MONGO_URI, { maxPoolSize: 200 });
let mongoDb = null;

async function connectMongo() {
  if (mongoDb) return mongoDb;
  await mongoClient.connect();
  mongoDb = mongoClient.db("atm_security");
  console.log("Connected to MongoDB Atlas (atm_security)");
  return mongoDb;
}

module.exports = { pgPool, connectMongo };