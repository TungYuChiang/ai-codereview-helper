<%@ page contentType="text/html; charset=UTF-8" %>
<%@ taglib prefix="c" uri="http://java.sun.com/jsp/jstl/core" %>
<%--
  A JSP comment that contains <% and %> and an unbalanced brace {
--%>
<html>
<head><title>Sample</title></head>
<body>

<%
  String title = "Report";
  if (title != null) {
    out.print("<h1>" + title + "</h1>");
  }
%>

<c:forEach items="${rows}" var="row">
  <div>${row.name}</div>
</c:forEach>

<%!
  private String formatName(String raw) {
    if (raw == null) {
      return "";
    }
    return raw.trim() + " %>";
  }

  static class Row {
    String render() {
      return "<tr/>";
    }
  }
%>

<div><%= formatName("x") %></div>

<%!
  private static final int LIMIT = 100;
  int total(int[] xs) {
    int sum = 0;
    for (int x : xs) {
      sum += x;
    }
    return sum;
  }
%>

</body>
</html>
