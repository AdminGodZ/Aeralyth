mod config;
mod db;
mod routes;
mod state;

use actix_web::{App, HttpServer, middleware::Logger, web};
use std::io;

use state::AppState;

#[actix_web::main]
async fn main() -> std::io::Result<()> {
    dotenvy::dotenv().ok();
    env_logger::init_from_env(env_logger::Env::new().default_filter_or("info"));

    let config = config::Config::from_env();
    let bind_addr = config.bind_addr();
    let db = db::connect(&config.database_url)
        .await
        .map_err(|error| io::Error::other(format!("failed to connect to postgres: {error}")))?;
    let state = web::Data::new(AppState {
        config: config.clone(),
        db,
    });

    log::info!("starting Aeralyth API on {bind_addr}");

    HttpServer::new(move || {
        App::new()
            .app_data(state.clone())
            .wrap(Logger::default())
            .configure(routes::configure)
    })
    .bind(&bind_addr)?
    .run()
    .await
}
