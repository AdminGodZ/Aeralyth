use tokio_postgres::{Client, Error, NoTls};

pub async fn connect(database_url: &str) -> Result<Client, Error> {
    let (client, connection) = tokio_postgres::connect(database_url, NoTls).await?;

    actix_web::rt::spawn(async move {
        if let Err(error) = connection.await {
            log::error!("postgres connection error: {error}");
        }
    });

    Ok(client)
}
