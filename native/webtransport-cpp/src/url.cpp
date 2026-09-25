#include "url.hpp"

#include <charconv>
#include <limits>

namespace deherm::webtransport::detail {

bool parseHttpsUrl(const std::string_view source, ParsedUrl& output) noexcept {
  constexpr std::string_view prefix = "https://";
  if (source.size() < prefix.size() || source.substr(0, prefix.size()) != prefix) return false;

  const auto authority_begin = prefix.size();
  const auto slash = source.find('/', authority_begin);
  const auto authority_view = source.substr(authority_begin, slash - authority_begin);
  if (authority_view.empty() || authority_view.find('@') != std::string_view::npos) return false;

  std::string_view host_view = authority_view;
  std::uint16_t port = 443;
  if (authority_view.front() == '[') {
    const auto close = authority_view.find(']');
    if (close == std::string_view::npos || close == 1) return false;
    host_view = authority_view.substr(1, close - 1);
    if (close + 1 < authority_view.size()) {
      if (authority_view[close + 1] != ':') return false;
      const auto port_view = authority_view.substr(close + 2);
      unsigned parsed = 0;
      const auto result = std::from_chars(port_view.data(), port_view.data() + port_view.size(), parsed);
      if (result.ec != std::errc{} || result.ptr != port_view.data() + port_view.size() || parsed == 0 ||
          parsed > std::numeric_limits<std::uint16_t>::max()) {
        return false;
      }
      port = static_cast<std::uint16_t>(parsed);
    }
  } else {
    const auto colon = authority_view.rfind(':');
    if (colon != std::string_view::npos) {
      if (authority_view.find(':') != colon) return false;  // IPv6 literals require brackets.
      host_view = authority_view.substr(0, colon);
      const auto port_view = authority_view.substr(colon + 1);
      unsigned parsed = 0;
      const auto result = std::from_chars(port_view.data(), port_view.data() + port_view.size(), parsed);
      if (result.ec != std::errc{} || result.ptr != port_view.data() + port_view.size() || parsed == 0 ||
          parsed > std::numeric_limits<std::uint16_t>::max()) {
        return false;
      }
      port = static_cast<std::uint16_t>(parsed);
    }
  }
  if (host_view.empty()) return false;

  output.host.assign(host_view);
  output.authority.assign(authority_view);
  output.path = slash == std::string_view::npos ? "/" : std::string(source.substr(slash));
  const auto fragment = output.path.find('#');
  if (fragment != std::string::npos) return false;
  output.port = port;
  return true;
}

}  // namespace deherm::webtransport::detail
