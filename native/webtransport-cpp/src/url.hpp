#pragma once

#include <cstdint>
#include <string>
#include <string_view>

namespace deherm::webtransport::detail {

struct ParsedUrl {
  std::string host;
  std::string authority;
  std::string path;
  std::uint16_t port = 443;
};

bool parseHttpsUrl(std::string_view source, ParsedUrl& output) noexcept;

}  // namespace deherm::webtransport::detail
