using Cipheroom.Api.Hubs;
using Cipheroom.Api.Rooms;
using Cipheroom.Api.Rtc;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddSingleton(TimeProvider.System);
builder.Services.AddSingleton<IRoomRegistry, InMemoryRoomRegistry>();
builder.Services.AddRtc();
builder.Services.AddSignalR(o => o.MaximumReceiveMessageSize = 64 * 1024);
builder.Services.AddHealthChecks();

var app = builder.Build();

app.MapHealthChecks("/healthz");
app.MapHub<RoomHub>("/hubs/room");

app.Run();

public partial class Program;
