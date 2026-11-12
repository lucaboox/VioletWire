mod assets;
mod connection;
mod flow;
mod history;
pub mod model;
mod view;
pub(crate) use assets::image_url as is_image_url;
pub use view::Chat;

pub fn probe(login: &str) -> anyhow::Result<()> {
    anyhow::ensure!(crate::format::is_login(login), "Invalid Twitch channel");
    let connection = connection::Connection::new(login);
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(12);
    let (mut connected, mut count, mut emotes, mut room) = (false, 0, 0, String::new());
    while std::time::Instant::now() < deadline {
        if let Ok(event) = connection
            .events
            .recv_timeout(std::time::Duration::from_millis(500))
        {
            match event {
                model::Event::State("Connected") => connected = true,
                model::Event::Message(m) => {
                    count += 1;
                    emotes += m.emotes.len();
                }
                model::Event::Room(id) => room = id,
                _ => {}
            }
        }
    }
    drop(connection);
    let assets = assets::load(&room, None);
    println!(
        "chat_connected={connected} messages={count} native_emote_ranges={emotes} provider_emotes={}",
        assets.emotes.len()
    );
    anyhow::ensure!(connected, "Could not connect to public chat");
    Ok(())
}
